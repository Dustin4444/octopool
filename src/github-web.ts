import { HttpError, parsePositiveInt } from "./http";
import { responseCapBytes } from "./github";
import { gitRefResponse, parseGitUploadPackAdvertisement } from "./github-git";
import { decodeURIComponentSafe, encodedPathSegments, safeRelativePath } from "./github-path";
import { defaultGitHubJSONAccept, githubResponseHeaders } from "./github-response";
import {
  parseActionsJobGroupsJSON,
  parseActionsJobHTML,
  parseActionsRunHTML,
  parseActionsRunListHTML,
  parseCommitPatchSHA,
  parseIssueHTML,
  parseIssueListHTML,
  parseLabelListHTML,
  parsePullRequestHTML,
  parseReleaseHTML,
  parseRepositoryNodeIDHTML,
  parseWorkflowListHTML,
  parseWorkflowPageCount,
} from "./github-html";
import {
  publicAPIRateBelowHalf,
  publicAPIRequest,
  releaseAPIRequest,
  storedPublicAPIRateBelowHalf,
  storePublicAPIRate,
} from "./github-public-api";
import { mediaFormat, mediaWebRequest, rawContentRequest } from "./github-public-content";
import type { WebRequest } from "./github-web-types";
import { readBodyCapped } from "./response-body";
import type { GitHubRelayResponse, RelayRequest, RouteInfo } from "./types";

const ACTIONS_SUMMARY_SHAPE = "actions-summary-v1";
const ACTIONS_JOBS_SHAPE = "actions-jobs-v1";
const ISSUE_SUMMARY_SHAPE = "issue-summary-v1";
const ISSUE_LIST_SHAPE = "issue-list-v1";
const PR_LIST_SHAPE = "pr-list-v1";
const PR_SUMMARY_SHAPE = "pr-summary-v1";
const LABEL_LIST_SHAPE = "label-list-v1";
const WORKFLOW_LIST_SHAPE = "workflow-list-v1";
const WORKFLOW_VIEW_SHAPE = "workflow-view-v1";
const RELEASE_SUMMARY_SHAPE = "release-summary-v1";
const MAX_PUBLIC_JOB_PAGES = 25;
const MAX_PUBLIC_WORKFLOW_PAGES = 10;

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
  if (hasPublicAlternative && (await storedPublicAPIRateBelowHalf(env, route.resource))) {
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
      await storePublicAPIRate(env, route.resource, response.headers);
    }
    if (response.status < 200 || response.status >= 300) {
      continue;
    }
    try {
      const body = await readWebBody(response, web.capBytes);
      const payload = await web.payload(
        new Uint8Array(body),
        response.headers,
        response.status,
        responseURL,
      );
      if (payload !== undefined) {
        if (web.usesApiQuota) {
          if (
            publicAPIRateBelowHalf(response.headers) &&
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

function webRequests(env: Env, request: RelayRequest, route: RouteInfo): WebRequest[] {
  const media = mediaFormat(request.headers?.accept);
  if (media !== undefined) {
    const mediaRequest = mediaWebRequest(env, request, route, media);
    return mediaRequest === undefined ? [] : [mediaRequest];
  }
  const out: WebRequest[] = [];
  const release = releaseAPIRequest(env, request, route);
  if (release !== undefined) {
    out.push(release);
  }
  const publicApi = publicAPIRequest(env, request, route);
  if (publicApi !== undefined) {
    out.push(publicApi);
  }
  const gitRef = gitRefRequest(env, request, route);
  if (gitRef !== undefined) {
    out.push(gitRef);
  }
  const summaryPage = summaryPageRequest(env, request, route);
  if (summaryPage !== undefined) {
    out.push(summaryPage);
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

function summaryPageRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    route.owner === undefined ||
    route.repo === undefined ||
    !defaultGitHubJSONAccept(request.headers?.accept)
  ) {
    return undefined;
  }
  const shape = request.headers?.["x-octopool-public-shape"];
  let url: URL;
  let parse: (html: string) => unknown | undefined;
  if (route.kind === "pr_view" && shape === PR_SUMMARY_SHAPE) {
    if (Object.keys(request.query ?? {}).length !== 0) {
      return undefined;
    }
    const number = /\/pulls\/([0-9]+)$/.exec(request.path)?.[1];
    if (number === undefined) {
      return undefined;
    }
    url = new URL(
      `https://github.com/${encodedPathSegments([route.owner, route.repo, "pull", number])}`,
    );
    parse = (html) => parsePullRequestHTML(html, route.owner!, route.repo!, Number(number));
  } else if (route.kind === "issue_view" && shape === ISSUE_SUMMARY_SHAPE) {
    if (Object.keys(request.query ?? {}).length !== 0) {
      return undefined;
    }
    const number = /\/issues\/([0-9]+)$/.exec(request.path)?.[1];
    if (number === undefined) {
      return undefined;
    }
    url = new URL(
      `https://github.com/${encodedPathSegments([route.owner, route.repo, "issues", number])}`,
    );
    parse = (html) => parseIssueHTML(html, route.owner!, route.repo!, Number(number));
  } else if (
    (route.kind === "issue_list" && shape === ISSUE_LIST_SHAPE) ||
    (route.kind === "pr_list" && shape === PR_LIST_SHAPE)
  ) {
    const kind = route.kind === "pr_list" ? "pr" : "issue";
    const query = issueListPageQuery(request.query, kind);
    if (query === undefined) {
      return undefined;
    }
    url = new URL(`https://github.com/${encodedPathSegments([route.owner, route.repo, "issues"])}`);
    url.searchParams.set("q", query.search);
    parse = (html) => {
      const items = parseIssueListHTML(html, route.owner!, route.repo!, kind);
      return items === undefined ? undefined : items.slice(0, query.perPage);
    };
  } else if (route.kind === "label_list" && shape === LABEL_LIST_SHAPE) {
    const query = simplePageQuery(request.query);
    if (query === undefined) {
      return undefined;
    }
    url = new URL(`https://github.com/${encodedPathSegments([route.owner, route.repo, "labels"])}`);
    parse = (html) => {
      const items = parseLabelListHTML(html, route.owner!, route.repo!);
      return items === undefined ? undefined : items.slice(0, query.perPage);
    };
  } else if (
    (route.kind === "workflow_list" && shape === WORKFLOW_LIST_SHAPE) ||
    (route.kind === "workflow_view" && shape === WORKFLOW_VIEW_SHAPE)
  ) {
    const query =
      route.kind === "workflow_list"
        ? simplePageQuery(request.query)
        : Object.keys(request.query ?? {}).length === 0
          ? { perPage: 100 }
          : undefined;
    if (query === undefined) {
      return undefined;
    }
    const workflowRef =
      route.kind === "workflow_view"
        ? decodePathComponent(/\/actions\/workflows\/([^/?#]+)$/.exec(request.path)?.[1] ?? "")
        : undefined;
    if (route.kind === "workflow_view" && workflowRef === undefined) {
      return undefined;
    }
    url = new URL(
      `https://github.com/${encodedPathSegments([route.owner, route.repo, "actions"])}`,
    );
    return {
      url: url.toString(),
      headers: { accept: "text/html", "user-agent": "octopool" },
      capBytes: responseCapBytes(env, route),
      usesApiQuota: false,
      payload: async (body, headers, status) => {
        const html = new TextDecoder().decode(body);
        const workflows = await completeWorkflowList(env, route, html);
        if (workflows === undefined) {
          return undefined;
        }
        const bodyValue =
          route.kind === "workflow_view"
            ? workflows.find(
                (workflow) =>
                  String(workflow.id) === workflowRef ||
                  workflow.path === `.github/workflows/${workflowRef}`,
              )
            : {
                total_count: workflows.length,
                workflows: workflows.slice(0, query.perPage),
              };
        if (bodyValue === undefined) {
          return undefined;
        }
        return {
          status,
          headers: webHeaders(headers, "application/json"),
          body: bodyValue,
          body_encoding: "json",
          backend: "web",
        };
      },
    };
  } else {
    return undefined;
  }
  return {
    url: url.toString(),
    headers: { accept: "text/html", "user-agent": "octopool" },
    capBytes: responseCapBytes(env, route),
    usesApiQuota: false,
    payload: (body, headers, status) => {
      const parsed = parse(new TextDecoder().decode(body));
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

async function completeWorkflowList(
  env: Env,
  route: RouteInfo,
  html: string,
): Promise<Record<string, unknown>[] | undefined> {
  const pageCount = parseWorkflowPageCount(html);
  const first = parseWorkflowListHTML(html, route.owner!, route.repo!);
  // Missing pagination metadata cannot prove the first page is complete.
  if (pageCount === undefined || pageCount > MAX_PUBLIC_WORKFLOW_PAGES || first === undefined) {
    return undefined;
  }
  const workflows = [...first];
  for (let page = 2; page <= pageCount; page++) {
    const next = await fetchPublicPage(
      `https://github.com/${encodedPathSegments([
        route.owner!,
        route.repo!,
        "actions",
        "workflows_partial",
      ])}?query=&page=${page}`,
      responseCapBytes(env, route),
      env,
    );
    const parsed =
      next === undefined ? undefined : parseWorkflowListHTML(next, route.owner!, route.repo!);
    if (parsed === undefined) {
      return undefined;
    }
    workflows.push(...parsed);
  }
  const unique = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  if (unique.size !== workflows.length) {
    return undefined;
  }
  return [...unique.values()].sort((left, right) =>
    compareStrings(String(left.path), String(right.path)),
  );
}

function gitRefRequest(env: Env, request: RelayRequest, route: RouteInfo): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    route.owner === undefined ||
    route.repo === undefined ||
    (route.kind !== "git_ref" && route.kind !== "git_matching_refs") ||
    !defaultGitHubJSONAccept(request.headers?.accept) ||
    Object.keys(request.query ?? {}).length !== 0
  ) {
    return undefined;
  }
  const prefix =
    route.kind === "git_ref"
      ? `/repos/${route.owner}/${route.repo}/git/ref/`
      : `/repos/${route.owner}/${route.repo}/git/matching-refs/`;
  const requested = decodePathComponent(request.path.slice(prefix.length));
  if (
    requested === undefined ||
    !safeRelativePath(requested, 200) ||
    (requested !== "heads" &&
      !requested.startsWith("heads/") &&
      requested !== "tags" &&
      !requested.startsWith("tags/"))
  ) {
    return undefined;
  }
  return {
    url: `https://github.com/${encodedPathSegments([route.owner, `${route.repo}.git`])}/info/refs?service=git-upload-pack`,
    headers: {
      accept: "application/x-git-upload-pack-advertisement",
      "user-agent": "octopool",
    },
    capBytes: responseCapBytes(env, route),
    usesApiQuota: false,
    payload: async (body, headers, status) => {
      const refs = parseGitUploadPackAdvertisement(body);
      if (refs === undefined) {
        return undefined;
      }
      const repositoryPage = await fetchPublicPage(
        `https://github.com/${encodedPathSegments([route.owner!, route.repo!, "issues"])}?q=is%3Aissue`,
        responseCapBytes(env, route),
        env,
      );
      const repositoryNodeID =
        repositoryPage === undefined ? undefined : parseRepositoryNodeIDHTML(repositoryPage);
      if (repositoryNodeID === undefined) {
        return undefined;
      }
      const parsed = gitRefResponse(
        refs,
        repositoryNodeID,
        route.owner!,
        route.repo!,
        requested,
        route.kind === "git_matching_refs",
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

function issueListPageQuery(
  query: Record<string, string | string[]> | undefined,
  kind: "issue" | "pr",
): { perPage: number; search: string } | undefined {
  const allowed =
    kind === "issue"
      ? new Set(["per_page", "page", "state", "creator", "assignee", "labels"])
      : new Set(["per_page", "page", "state"]);
  if (
    Object.entries(query ?? {}).some(
      ([key, value]) => !allowed.has(key) || Array.isArray(value) || value === "",
    )
  ) {
    return undefined;
  }
  const pageQuery = simplePageQuery(query, allowed);
  if (pageQuery === undefined) {
    return undefined;
  }
  const state = stringQuery(query, "state") ?? "open";
  if (!["open", "closed", "all"].includes(state)) {
    return undefined;
  }
  const qualifiers = [`is:${kind}`];
  if (state !== "all") {
    qualifiers.push(`state:${state}`);
  }
  for (const key of ["creator", "assignee"] as const) {
    const value = stringQuery(query, key);
    if (value === undefined) {
      continue;
    }
    const encoded = searchQualifier(key === "creator" ? "author" : key, value);
    if (encoded === undefined) {
      return undefined;
    }
    qualifiers.push(encoded);
  }
  const labels = stringQuery(query, "labels");
  if (labels !== undefined) {
    for (const label of labels.split(",")) {
      const encoded = searchQualifier("label", label);
      if (encoded === undefined) {
        return undefined;
      }
      qualifiers.push(encoded);
    }
  }
  return { perPage: pageQuery.perPage, search: qualifiers.join(" ") };
}

function simplePageQuery(
  query: Record<string, string | string[]> | undefined,
  allowed = new Set(["per_page", "page"]),
): { perPage: number } | undefined {
  if (
    Object.entries(query ?? {}).some(
      ([key, value]) => !allowed.has(key) || Array.isArray(value) || value === "",
    ) ||
    (stringQuery(query, "page") !== undefined && stringQuery(query, "page") !== "1")
  ) {
    return undefined;
  }
  const perPage = Number(stringQuery(query, "per_page") ?? "30");
  return Number.isInteger(perPage) && perPage >= 1 && perPage <= 100 ? { perPage } : undefined;
}

function searchQualifier(key: string, value: string): string | undefined {
  if (
    value === "" ||
    value.length > 200 ||
    value.includes("\0") ||
    value.includes('"') ||
    value.includes("\\")
  ) {
    return undefined;
  }
  return `${key}:"${value}"`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
    !defaultGitHubJSONAccept(request.headers?.accept)
  ) {
    return undefined;
  }
  const shape = request.headers?.["x-octopool-public-shape"];
  if (
    (route.kind === "run_list" || route.kind === "workflow_run_list") &&
    shape === ACTIONS_SUMMARY_SHAPE
  ) {
    const query = actionsListQuery(request.query);
    if (query === undefined) {
      return undefined;
    }
    const workflow =
      route.kind === "workflow_run_list"
        ? /\/actions\/workflows\/([^/]+)\/runs$/.exec(request.path)?.[1]
        : undefined;
    if (route.kind === "workflow_run_list" && workflow === undefined) {
      return undefined;
    }
    const url = new URL(
      `https://github.com/${encodedPathSegments([
        route.owner,
        route.repo,
        "actions",
        ...(workflow === undefined ? [] : ["workflows", decodeURIComponentSafe(workflow)]),
      ])}`,
    );
    if (query.search !== "") {
      url.searchParams.set("query", query.search);
    }
    return {
      url: url.toString(),
      headers: { accept: "text/html", "user-agent": "octopool" },
      capBytes: responseCapBytes(env, route),
      usesApiQuota: false,
      payload: async (body, headers, status) => {
        const parsed = parseActionsRunListHTML(
          new TextDecoder().decode(body),
          route.owner!,
          route.repo!,
        );
        if (parsed === undefined) {
          return undefined;
        }
        parsed.workflow_runs = parsed.workflow_runs.slice(0, query.perPage);
        const runs = await Promise.all(
          parsed.workflow_runs.map((run) =>
            isFullGitSHA(run.head_sha) ? run : enrichActionsRun(env, route, run),
          ),
        );
        if (runs.some((run) => run === undefined)) {
          return undefined;
        }
        parsed.workflow_runs = runs as Record<string, unknown>[];
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
  if (
    route.kind === "run_view" &&
    shape === ACTIONS_SUMMARY_SHAPE &&
    Object.keys(request.query ?? {}).length === 0
  ) {
    const id = /\/actions\/runs\/([0-9]+)$/.exec(request.path)?.[1];
    if (id === undefined) {
      return undefined;
    }
    return {
      url: `https://github.com/${encodedPathSegments([route.owner, route.repo, "actions", "runs", id])}`,
      headers: { accept: "text/html", "user-agent": "octopool" },
      capBytes: responseCapBytes(env, route),
      usesApiQuota: false,
      payload: async (body, headers, status) => {
        const parsed = parseActionsRunHTML(
          new TextDecoder().decode(body),
          route.owner!,
          route.repo!,
          Number(id),
        );
        const complete =
          parsed === undefined ? undefined : await completeActionsRunSHA(env, route, parsed);
        return complete === undefined
          ? undefined
          : {
              status,
              headers: webHeaders(headers, "application/json"),
              body: complete,
              body_encoding: "json",
              backend: "web",
            };
      },
    };
  }
  if (route.kind === "run_jobs" && shape === ACTIONS_JOBS_SHAPE) {
    const id = /\/actions\/runs\/([0-9]+)\/jobs$/.exec(request.path)?.[1];
    const query = actionsJobsQuery(request.query);
    if (id === undefined || query === undefined) {
      return undefined;
    }
    const runID = Number(id);
    return {
      url: `https://github.com/${encodedPathSegments([
        route.owner,
        route.repo,
        "actions",
        "runs",
        id,
        "job_groups_batch",
      ])}?attempt=1`,
      headers: {
        accept: "application/json",
        referer: `https://github.com/${encodedPathSegments([
          route.owner,
          route.repo,
          "actions",
          "runs",
          id,
        ])}`,
        "user-agent": "octopool",
        "x-requested-with": "XMLHttpRequest",
      },
      capBytes: responseCapBytes(env, route),
      usesApiQuota: false,
      payload: async (body, headers, status) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
        } catch {
          return undefined;
        }
        const summaries = parseActionsJobGroupsJSON(parsed, route.owner!, route.repo!, runID);
        if (summaries === undefined || summaries.length > MAX_PUBLIC_JOB_PAGES) {
          return undefined;
        }
        const jobs = await Promise.all(
          summaries.slice(0, query.perPage).map(async (summary) => {
            const page = await fetchPublicPage(
              `https://github.com${summary.href}`,
              responseCapBytes(env, route),
              env,
            );
            return page === undefined
              ? undefined
              : parseActionsJobHTML(page, summary, route.owner!, route.repo!);
          }),
        );
        if (jobs.some((job) => job === undefined)) {
          return undefined;
        }
        return {
          status,
          headers: webHeaders(headers, "application/json"),
          body: { total_count: summaries.length, jobs },
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

function actionsJobsQuery(
  query: Record<string, string | string[]> | undefined,
): { perPage: number } | undefined {
  const allowed = new Set(["per_page", "page", "filter"]);
  if (
    Object.entries(query ?? {}).some(
      ([key, value]) => !allowed.has(key) || Array.isArray(value) || value === "",
    ) ||
    (stringQuery(query, "page") !== undefined && stringQuery(query, "page") !== "1") ||
    (stringQuery(query, "filter") !== undefined && stringQuery(query, "filter") !== "latest")
  ) {
    return undefined;
  }
  const perPage = Number(stringQuery(query, "per_page") ?? "30");
  return Number.isInteger(perPage) && perPage >= 1 && perPage <= 100 ? { perPage } : undefined;
}

async function fetchPublicPage(
  url: string,
  capBytes: number,
  env: Env,
  accept = "text/html",
): Promise<string | undefined> {
  const timeoutMs = parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000);
  const headers = { accept, "user-agent": "octopool" };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return undefined;
  }
  if (response.status >= 300 && response.status < 400) {
    const redirected = await fetchAllowedRedirect(response, { headers }, timeoutMs, url);
    if (redirected === undefined) {
      return undefined;
    }
    response = redirected.response;
  }
  if (response.status < 200 || response.status >= 300) {
    return undefined;
  }
  try {
    return new TextDecoder().decode(await readWebBody(response, capBytes));
  } catch {
    return undefined;
  }
}

async function enrichActionsRun(
  env: Env,
  route: RouteInfo,
  run: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (
    route.owner === undefined ||
    route.repo === undefined ||
    typeof run.id !== "number" ||
    !Number.isInteger(run.id)
  ) {
    return undefined;
  }
  const page = await fetchPublicPage(
    `https://github.com/${encodedPathSegments([
      route.owner,
      route.repo,
      "actions",
      "runs",
      String(run.id),
    ])}`,
    responseCapBytes(env, route),
    env,
  );
  const parsed =
    page === undefined ? undefined : parseActionsRunHTML(page, route.owner, route.repo, run.id);
  return parsed === undefined
    ? undefined
    : completeActionsRunSHA(env, route, { ...run, ...parsed });
}

async function completeActionsRunSHA(
  env: Env,
  route: RouteInfo,
  run: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (isFullGitSHA(run.head_sha)) {
    return run;
  }
  if (
    route.owner === undefined ||
    route.repo === undefined ||
    typeof run.head_sha !== "string" ||
    !/^[0-9A-Fa-f]{7,39}$/.test(run.head_sha)
  ) {
    return undefined;
  }
  const patch = await fetchPublicPage(
    `https://github.com/${encodedPathSegments([
      route.owner,
      route.repo,
      "commit",
      `${run.head_sha}.patch`,
    ])}`,
    responseCapBytes(env, route),
    env,
    "text/plain",
  );
  const sha = patch === undefined ? undefined : parseCommitPatchSHA(patch);
  return sha === undefined ? undefined : { ...run, head_sha: sha };
}

function isFullGitSHA(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Fa-f]{40,64}$/.test(value);
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
    !defaultGitHubJSONAccept(request.headers?.accept) ||
    Object.keys(request.query ?? {}).length !== 0
  ) {
    return undefined;
  }
  let url: string;
  if (route.kind === "release_latest") {
    url = `https://github.com/${encodedPathSegments([route.owner, route.repo, "releases", "latest"])}`;
  } else if (route.kind === "release_view") {
    const encodedTag = /\/releases\/tags\/([^/?#]+)$/.exec(request.path)?.[1];
    if (encodedTag === undefined) {
      return undefined;
    }
    const tag = decodePathComponent(encodedTag);
    if (tag === undefined) {
      return undefined;
    }
    url = `https://github.com/${encodedPathSegments([route.owner, route.repo, "releases", "tag"])}/${encodeURIComponent(tag)}`;
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

function decodePathComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function stringQuery(
  query: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined {
  const value = query?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function webHeaders(headers: Headers, contentType: string): Record<string, string> {
  return githubResponseHeaders(headers, { contentType, includeCacheControl: true });
}

function readWebBody(response: Response, capBytes: number): Promise<Uint8Array> {
  return readBodyCapped(
    response,
    capBytes,
    () => new HttpError(502, "github_web_response_too_large", "GitHub web response is too large"),
  );
}
