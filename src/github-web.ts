import { HttpError, parsePositiveInt } from "./http";
import { responseCapBytes } from "./github";
import { parseActionsRunHTML, parseActionsRunListHTML, parseReleaseHTML } from "./github-html";
import { queries } from "./generated/sql";
import type { GitHubRelayResponse, RelayRequest, RouteInfo } from "./types";

const MEDIA_DIFF = new Set([
  "application/vnd.github.diff",
  "application/vnd.github.v3.diff",
  "application/vnd.github.v3+diff",
]);
const MEDIA_PATCH = new Set([
  "application/vnd.github.patch",
  "application/vnd.github.v3.patch",
  "application/vnd.github.v3+patch",
]);
const ACTIONS_SUMMARY_SHAPE = "actions-summary-v1";
const RELEASE_SUMMARY_SHAPE = "release-summary-v1";

export async function callGitHubWeb(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): Promise<GitHubRelayResponse | undefined> {
  let requests = webRequests(env, request, route);
  if (requests.length === 0) {
    return undefined;
  }
  const hasPublicAlternative =
    requests.some((candidate) => candidate.usesApiQuota) &&
    requests.some((candidate) => !candidate.usesApiQuota);
  if (hasPublicAlternative && (await storedPublicApiRateBelowHalf(env, route.resource))) {
    requests = [
      ...requests.filter((candidate) => !candidate.usesApiQuota),
      ...requests.filter((candidate) => candidate.usesApiQuota),
    ];
  }
  let deferredApiPayload: GitHubRelayResponse | undefined;
  for (const [index, web] of requests.entries()) {
    let response: Response;
    let responseURL = web.url;
    const timeoutMs = parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000);
    try {
      response = await fetch(web.url, {
        method: "GET",
        headers: web.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      continue;
    }
    responseURL = response.url || web.url;
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const redirected = await fetchAllowedRedirect(response, web, timeoutMs, responseURL);
      if (redirected === undefined) {
        continue;
      }
      response = redirected.response;
      responseURL = redirected.url;
    }
    if (web.usesApiQuota) {
      await storePublicApiRate(env, route.resource, response.headers);
    }
    if (response.status < 200 || response.status >= 300) {
      continue;
    }
    try {
      const body = await readBodyCapped(response, web.capBytes);
      const payload = web.payload(
        new Uint8Array(body),
        response.headers,
        response.status,
        responseURL,
      );
      if (payload !== undefined) {
        if (web.usesApiQuota) {
          if (
            publicApiRateBelowHalf(response.headers) &&
            requests.slice(index + 1).some((candidate) => !candidate.usesApiQuota)
          ) {
            deferredApiPayload = payload;
            continue;
          }
        }
        return payload;
      }
    } catch {
      continue;
    }
  }
  return deferredApiPayload;
}

async function fetchAllowedRedirect(
  response: Response,
  web: {
    headers: Record<string, string>;
  },
  timeoutMs: number,
  responseURL: string,
): Promise<{ response: Response; url: string } | undefined> {
  const location = response.headers.get("location");
  if (location === null) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(location, responseURL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !allowedWebRedirectHost(url.hostname)) {
    return undefined;
  }
  try {
    const redirected = await fetch(url.toString(), {
      method: "GET",
      headers: web.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (redirected.status >= 300 && redirected.status < 400) {
      return undefined;
    }
    return { response: redirected, url: redirected.url || url.toString() };
  } catch {
    return undefined;
  }
}

function allowedWebRedirectHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "patch-diff.githubusercontent.com" ||
    lower === "github.com" ||
    lower === "raw.githubusercontent.com"
  );
}

type WebRequest = {
  url: string;
  headers: Record<string, string>;
  capBytes: number;
  usesApiQuota: boolean;
  payload: (
    body: Uint8Array,
    headers: Headers,
    status: number,
    responseURL: string,
  ) => GitHubRelayResponse | undefined;
};

function webRequests(env: Env, request: RelayRequest, route: RouteInfo): WebRequest[] {
  const media = mediaFormat(request.headers?.accept);
  if (media !== undefined) {
    const mediaRequest = mediaWebRequest(env, request, route, media);
    return mediaRequest === undefined ? [] : [mediaRequest];
  }
  const out: WebRequest[] = [];
  const release = releaseRequest(env, request, route);
  if (release !== undefined) {
    out.push(release);
  }
  const publicApi = publicApiRequest(env, request, route);
  if (publicApi !== undefined) {
    out.push(publicApi);
  }
  const actions = actionsPageRequest(env, request, route);
  if (actions !== undefined) {
    out.push(actions);
  }
  const releasePage = releasePageRequest(env, request, route);
  if (releasePage !== undefined) {
    out.push(releasePage);
  }
  const rawContent = rawContentRequest(env, request, route);
  if (rawContent !== undefined) {
    out.push(rawContent);
  }
  return out;
}

function actionsPageRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    route.owner === undefined ||
    route.repo === undefined ||
    request.headers?.["x-octopool-public-shape"] !== ACTIONS_SUMMARY_SHAPE ||
    !defaultJSONAccept(request.headers?.accept)
  ) {
    return undefined;
  }
  if (route.kind === "run_list") {
    const query = actionsListQuery(request.query);
    if (query === undefined) {
      return undefined;
    }
    const url = new URL(`https://github.com/${pathSegments([route.owner, route.repo, "actions"])}`);
    if (query.search !== "") {
      url.searchParams.set("query", query.search);
    }
    return {
      url: url.toString(),
      headers: { accept: "text/html", "user-agent": "octopool" },
      capBytes: responseCapBytes(env, route),
      usesApiQuota: false,
      payload: (body, headers, status) => {
        const parsed = parseActionsRunListHTML(
          new TextDecoder().decode(body),
          route.owner!,
          route.repo!,
        );
        if (parsed === undefined) {
          return undefined;
        }
        parsed.workflow_runs = parsed.workflow_runs.slice(0, query.perPage);
        return {
          status,
          headers: webHeaders(headers, "application/json"),
          body: parsed,
          body_encoding: "json",
          backend: "web",
        };
      },
    };
  }
  if (route.kind === "run_view" && Object.keys(request.query ?? {}).length === 0) {
    const id = /\/actions\/runs\/([0-9]+)$/.exec(request.path)?.[1];
    if (id === undefined) {
      return undefined;
    }
    return {
      url: `https://github.com/${pathSegments([route.owner, route.repo, "actions", "runs", id])}`,
      headers: { accept: "text/html", "user-agent": "octopool" },
      capBytes: responseCapBytes(env, route),
      usesApiQuota: false,
      payload: (body, headers, status) => {
        const parsed = parseActionsRunHTML(
          new TextDecoder().decode(body),
          route.owner!,
          route.repo!,
          Number(id),
        );
        return parsed === undefined
          ? undefined
          : {
              status,
              headers: webHeaders(headers, "application/json"),
              body: parsed,
              body_encoding: "json",
              backend: "web",
            };
      },
    };
  }
  return undefined;
}

function actionsListQuery(
  query: Record<string, string | string[]> | undefined,
): { perPage: number; search: string } | undefined {
  const allowed = new Set(["per_page", "page", "branch", "status"]);
  if (
    Object.entries(query ?? {}).some(
      ([key, value]) => !allowed.has(key) || Array.isArray(value) || value === "",
    )
  ) {
    return undefined;
  }
  if (stringQuery(query, "page") !== undefined && stringQuery(query, "page") !== "1") {
    return undefined;
  }
  const perPage = Number(stringQuery(query, "per_page") ?? "25");
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 25) {
    return undefined;
  }
  const qualifiers: string[] = [];
  for (const key of ["branch", "status"] as const) {
    const value = stringQuery(query, key);
    if (value === undefined) {
      continue;
    }
    if (value.length > 200 || value.includes("\0") || /[\s"\\]/.test(value)) {
      return undefined;
    }
    qualifiers.push(`${key}:${value}`);
  }
  return { perPage, search: qualifiers.join(" ") };
}

function mediaWebRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
  media: "diff" | "patch",
): WebRequest | undefined {
  if (request.method !== "GET" || route.owner === undefined || route.repo === undefined) {
    return undefined;
  }
  const mediaURL = mediaWebURL(request, route, media);
  if (mediaURL === undefined) {
    return undefined;
  }
  const contentType = media === "patch" ? "text/x-patch" : "text/x-diff";
  return {
    url: mediaURL,
    headers: { accept: `${contentType}, text/plain, */*`, "user-agent": "octopool" },
    capBytes: responseCapBytes(env, route),
    usesApiQuota: false,
    payload: (body, headers, status) => ({
      status,
      headers: webHeaders(headers, contentType),
      body: new TextDecoder().decode(body),
      body_encoding: "text",
      backend: "web",
    }),
  };
}

function rawContentRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (request.method !== "GET" || route.owner === undefined || route.repo === undefined) {
    return undefined;
  }
  if (route.kind !== "contents" || !defaultJSONAccept(request.headers?.accept)) {
    return undefined;
  }
  const ref = stringQuery(request.query, "ref");
  if (ref === undefined || !safeGitRefPath(ref)) {
    return undefined;
  }
  const contentPath = contentPathFromRequest(request, route);
  if (contentPath === undefined || !safeRelativePath(contentPath)) {
    return undefined;
  }
  const rawURL = `https://raw.githubusercontent.com/${pathSegments([route.owner, route.repo, ref, contentPath])}`;
  return {
    url: rawURL,
    headers: { accept: "text/plain, */*", "user-agent": "octopool" },
    capBytes: responseCapBytes(env, route),
    usesApiQuota: false,
    payload: (body, headers, status) => {
      const sha = gitBlobSHA(body);
      const apiPath = `/repos/${route.owner}/${route.repo}/contents/${contentPath}`;
      const apiURL = `https://api.github.com${apiPath}?ref=${encodeURIComponent(ref)}`;
      const htmlURL = `https://github.com/${pathSegments([route.owner!, route.repo!, "blob", ref, contentPath])}`;
      return {
        status,
        headers: webHeaders(headers, "application/json"),
        body: {
          type: "file",
          encoding: "base64",
          name: contentPath.split("/").at(-1) ?? contentPath,
          path: contentPath,
          sha,
          size: body.byteLength,
          content: bytesToBase64(body),
          url: apiURL,
          html_url: htmlURL,
          git_url: `https://api.github.com/repos/${route.owner}/${route.repo}/git/blobs/${sha}`,
          download_url: rawURL,
          _links: {
            self: apiURL,
            git: `https://api.github.com/repos/${route.owner}/${route.repo}/git/blobs/${sha}`,
            html: htmlURL,
          },
        },
        body_encoding: "json",
        backend: "web",
      };
    },
  };
}

function releaseRequest(env: Env, request: RelayRequest, route: RouteInfo): WebRequest | undefined {
  if (!releaseRoute(route) || !defaultJSONAccept(request.headers?.accept)) {
    return undefined;
  }
  const url = new URL(`https://api.github.com${request.path}`);
  appendQuery(url, request.query);
  const ref = stringQuery(request.query, "ref");
  if (ref !== undefined) {
    return undefined;
  }
  return {
    url: url.toString(),
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "octopool",
      "x-github-api-version": request.headers?.["x-github-api-version"] ?? "2022-11-28",
    },
    capBytes: responseCapBytes(env, route),
    usesApiQuota: true,
    payload: (body, headers, status) => {
      const parsed = parsePublicReleaseBody(body, route);
      if (parsed === undefined) {
        return undefined;
      }
      return {
        status,
        headers: webHeaders(headers, "application/json"),
        body: parsed,
        body_encoding: "json",
        backend: "web",
      };
    },
  };
}

function releasePageRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    route.owner === undefined ||
    route.repo === undefined ||
    request.headers?.["x-octopool-public-shape"] !== RELEASE_SUMMARY_SHAPE ||
    !defaultJSONAccept(request.headers?.accept) ||
    Object.keys(request.query ?? {}).length !== 0
  ) {
    return undefined;
  }
  let url: string;
  if (route.kind === "release_latest") {
    url = `https://github.com/${pathSegments([route.owner, route.repo, "releases", "latest"])}`;
  } else if (route.kind === "release_view") {
    const encodedTag = /\/releases\/tags\/([^/?#]+)$/.exec(request.path)?.[1];
    if (encodedTag === undefined) {
      return undefined;
    }
    const tag = decodePathComponent(encodedTag);
    if (tag === undefined) {
      return undefined;
    }
    url = `https://github.com/${pathSegments([route.owner, route.repo, "releases", "tag"])}/${encodeURIComponent(tag)}`;
  } else {
    return undefined;
  }
  return {
    url,
    headers: { accept: "text/html", "user-agent": "octopool" },
    capBytes: responseCapBytes(env, route),
    usesApiQuota: false,
    payload: (body, headers, status, responseURL) => {
      const parsed = parseReleaseHTML(
        new TextDecoder().decode(body),
        route.owner!,
        route.repo!,
        responseURL,
      );
      return parsed === undefined
        ? undefined
        : {
            status,
            headers: webHeaders(headers, "application/json"),
            body: parsed,
            body_encoding: "json",
            backend: "web",
          };
    },
  };
}

function publicApiRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    !publicApiRoute(route) ||
    !defaultJSONAccept(request.headers?.accept)
  ) {
    return undefined;
  }
  const url = new URL(`https://api.github.com${request.path}`);
  appendQuery(url, request.query);
  return {
    url: url.toString(),
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "octopool",
      "x-github-api-version": request.headers?.["x-github-api-version"] ?? "2022-11-28",
    },
    capBytes: responseCapBytes(env, route),
    usesApiQuota: true,
    payload: (body, headers, status) => {
      if (body.byteLength === 0) {
        return {
          status,
          headers: webHeaders(headers, "application/json"),
          body: null,
          body_encoding: "text",
          backend: "web",
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
      } catch {
        return undefined;
      }
      if (route.kind === "gist_view" && !publicGist(parsed)) {
        return undefined;
      }
      return {
        status,
        headers: webHeaders(headers, "application/json"),
        body: parsed,
        body_encoding: "json",
        backend: "web",
      };
    },
  };
}

function releaseRoute(route: RouteInfo): boolean {
  return (
    route.kind === "release_list" ||
    route.kind === "release_latest" ||
    route.kind === "release_view"
  );
}

async function storedPublicApiRateBelowHalf(env: Env, resource: string): Promise<boolean> {
  try {
    const rate = await env.DB.prepare(queries.freshPublicApiRate)
      .bind(resource)
      .first<{ limit_count: number; remaining: number }>();
    return rate !== null && rate.remaining * 2 < rate.limit_count;
  } catch {
    return false;
  }
}

async function storePublicApiRate(env: Env, resource: string, headers: Headers): Promise<void> {
  const limit = headerInt(headers, "x-ratelimit-limit");
  const remaining = headerInt(headers, "x-ratelimit-remaining");
  const resetAt = headerInt(headers, "x-ratelimit-reset");
  if (limit === undefined || remaining === undefined || resetAt === undefined || limit <= 0) {
    return;
  }
  try {
    await env.DB.prepare(queries.upsertPublicApiRate)
      .bind(resource, limit, remaining, resetAt)
      .run();
  } catch {
    // Rate persistence is advisory; public reads still work without it.
  }
}

function publicApiRateBelowHalf(headers: Headers): boolean {
  const limit = headerInt(headers, "x-ratelimit-limit");
  const remaining = headerInt(headers, "x-ratelimit-remaining");
  return limit !== undefined && remaining !== undefined && limit > 0 && remaining * 2 < limit;
}

function headerInt(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function publicApiRoute(route: RouteInfo): boolean {
  switch (route.kind) {
    case "repo_view":
    case "user_repo_list":
    case "user_org_list":
    case "user_gist_list":
    case "user_follower_list":
    case "user_following_list":
    case "user_event_list":
    case "user_received_event_list":
    case "user_key_list":
    case "user_gpg_key_list":
    case "org_repo_list":
    case "org_event_list":
    case "org_public_member_list":
    case "org_public_member_view":
    case "gist_view":
    case "emoji_list":
    case "github_meta":
    case "license_list":
    case "license_view":
    case "gitignore_template_list":
    case "gitignore_template_view":
    case "commit_list":
    case "commit_view":
    case "commit_comments":
    case "commit_pulls":
    case "commit_branches_where_head":
    case "commit_statuses":
    case "repo_comment":
    case "compare":
    case "contents":
    case "repo_readme":
    case "pr_view":
    case "pr_list":
    case "pr_files":
    case "pr_commits":
    case "pr_review_comments":
    case "pr_review_comment_list":
    case "pr_review_comment_view":
    case "pr_review_comment_reactions":
    case "pr_reviews":
    case "pr_review_view":
    case "pr_review_comments_for_review":
    case "pr_requested_reviewers":
    case "commit_check_runs":
    case "commit_check_suites":
    case "commit_status":
    case "ref_statuses":
    case "run_list":
    case "run_view":
    case "run_jobs":
    case "run_artifacts":
    case "job_view":
    case "check_run_annotations":
    case "issue_view":
    case "issue_list":
    case "issue_comments":
    case "issue_comment_list":
    case "issue_comment_view":
    case "issue_comment_reactions":
    case "issue_events":
    case "issue_event_list":
    case "issue_event_view":
    case "issue_labels":
    case "issue_reactions":
    case "issue_timeline":
    case "assignee_list":
    case "assignee_view":
    case "label_list":
    case "label_view":
    case "milestone_list":
    case "milestone_view":
    case "branch_list":
    case "branch_view":
    case "tag_list":
    case "repo_languages":
    case "repo_contributors":
    case "repo_license":
    case "repo_topics":
    case "community_profile":
    case "fork_list":
    case "stargazer_list":
    case "subscriber_list":
    case "deployment_list":
    case "repo_event_list":
    case "network_event_list":
    case "repo_stats_contributors":
    case "repo_stats_commit_activity":
    case "repo_stats_code_frequency":
    case "repo_stats_participation":
    case "repo_stats_punch_card":
    case "git_blob":
    case "git_commit":
    case "git_tree":
    case "git_ref":
    case "git_matching_refs":
    case "workflow_list":
    case "workflow_view":
    case "workflow_run_list":
    case "release_assets":
    case "release_asset":
    case "search_issues":
    case "search_commits":
    case "search_repositories":
      return true;
    default:
      return false;
  }
}

function publicGist(value: unknown): boolean {
  return typeof value === "object" && value !== null && "public" in value && value.public === true;
}

function appendQuery(url: URL, query: Record<string, string | string[]> | undefined): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }
}

function parsePublicReleaseBody(body: Uint8Array, route: RouteInfo): unknown | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return undefined;
  }
  if (route.kind === "release_list") {
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return parsed.filter((item) => !releaseDraft(item));
  }
  return releaseDraft(parsed) ? undefined : parsed;
}

function releaseDraft(value: unknown): boolean {
  return typeof value === "object" && value !== null && "draft" in value && value.draft === true;
}

function mediaWebURL(
  request: RelayRequest,
  route: RouteInfo,
  media: "diff" | "patch",
): string | undefined {
  switch (route.kind) {
    case "pr_view": {
      const number = /\/pulls\/([0-9]+)$/.exec(request.path)?.[1];
      if (number === undefined) {
        return undefined;
      }
      return `https://github.com/${pathSegments([route.owner!, route.repo!, "pull", number])}.${media}`;
    }
    case "commit_view": {
      const sha = /\/commits\/([0-9A-Fa-f]{7,64})$/.exec(request.path)?.[1];
      if (sha === undefined) {
        return undefined;
      }
      return `https://github.com/${pathSegments([route.owner!, route.repo!, "commit", sha])}.${media}`;
    }
    case "compare": {
      const ref = /\/compare\/([^/?#]+)$/.exec(request.path)?.[1];
      if (ref === undefined) {
        return undefined;
      }
      const decodedRef = decodePathComponent(ref);
      if (decodedRef === undefined) {
        return undefined;
      }
      return `https://github.com/${pathSegments([route.owner!, route.repo!, "compare"])}/${encodeURIComponent(decodedRef)}.${media}`;
    }
    default:
      return undefined;
  }
}

function mediaFormat(accept: string | undefined): "diff" | "patch" | undefined {
  const normalized = (accept ?? "").toLowerCase();
  const values = normalized.split(",").map((item) => item.trim().split(";")[0] ?? "");
  if (values.some((value) => MEDIA_PATCH.has(value))) {
    return "patch";
  }
  if (values.some((value) => MEDIA_DIFF.has(value))) {
    return "diff";
  }
  return undefined;
}

function contentPathFromRequest(request: RelayRequest, route: RouteInfo): string | undefined {
  const prefix = `/repos/${route.owner}/${route.repo}/contents/`;
  if (!request.path.startsWith(prefix)) {
    return undefined;
  }
  const value = request.path.slice(prefix.length);
  if (value === "") {
    return undefined;
  }
  return decodePathComponent(value);
}

function decodePathComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function defaultJSONAccept(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") {
    return true;
  }
  const normalized = value.toLowerCase();
  return (
    normalized === "application/vnd.github+json" ||
    normalized === "application/json" ||
    normalized === "application/vnd.github.v3+json"
  );
}

function safeGitRefPath(value: string): boolean {
  return (
    value.length <= 200 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function safeRelativePath(value: string): boolean {
  return (
    value.length <= 1024 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function stringQuery(
  query: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined {
  const value = query?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function webHeaders(headers: Headers, contentType: string): Record<string, string> {
  const out: Record<string, string> = { "content-type": contentType };
  for (const key of [
    "etag",
    "last-modified",
    "cache-control",
    "link",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
    "x-ratelimit-used",
    "retry-after",
    "x-github-request-id",
  ]) {
    const value = headers.get(key);
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

async function readBodyCapped(response: Response, capBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > capBytes) {
        await reader.cancel();
        throw new HttpError(
          502,
          "github_web_response_too_large",
          "GitHub web response is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function pathSegments(segments: string[]): string {
  return segments
    .flatMap((segment) => segment.split("/"))
    .map(encodeURIComponent)
    .join("/");
}

function gitBlobSHA(body: Uint8Array): string {
  // WebCrypto SHA-1 is unavailable in some Workers runtimes, so keep this tiny implementation local.
  return sha1(new Uint8Array([...new TextEncoder().encode(`blob ${body.byteLength}\0`), ...body]));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function sha1(message: Uint8Array): string {
  const words: number[] = [];
  for (let index = 0; index < message.length; index++) {
    words[index >> 2] = (words[index >> 2] ?? 0) | (message[index]! << (24 - (index % 4) * 8));
  }
  words[message.length >> 2] =
    (words[message.length >> 2] ?? 0) | (0x80 << (24 - (message.length % 4) * 8));
  words[(((message.length + 8) >> 6) << 4) + 15] = message.length * 8;
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  for (let offset = 0; offset < words.length; offset += 16) {
    const w = Array.from({ length: 80 }, (_, index) => words[offset + index] ?? 0);
    for (let index = 16; index < 80; index++) {
      w[index] = rotateLeft(w[index - 3]! ^ w[index - 8]! ^ w[index - 14]! ^ w[index - 16]!, 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index++) {
      const [f, k] =
        index < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : index < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : index < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const temp = (rotateLeft(a, 5) + f + e + k + w[index]!) | 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}
