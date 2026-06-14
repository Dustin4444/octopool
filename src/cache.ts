import { hashToken } from "./auth";
import { deleteEdgeJSON, readEdgeJSON, writeEdgeJSON } from "./edge-cache";
import { queries } from "./generated/sql";
import type { GitHubRelayResponse, Identity, RelayRequest, RouteInfo } from "./types";

const TERMINAL_CI_TTL_SECONDS = 3_600;
const TERMINAL_CI_STALE_SECONDS = 86_400;
const TERMINAL_CI_TTL_DETECTION_SECONDS = 1_800;
const EDGE_CACHE_NAMESPACE = "github-v1";

type CacheRow = {
  status: number;
  response_headers_json: string;
  body_json: string;
  body_encoding: "json" | "text" | "base64";
  identity_id: string | null;
  identity_kind: "pat" | "github_app" | null;
  created_at: string;
  expires_at: string;
};

export type CachedGitHubResponse = GitHubRelayResponse & {
  identity?: Pick<Identity, "id" | "kind">;
  created_at: string;
  expires_at: string;
};

export async function githubCacheKey(
  pool: string,
  request: RelayRequest,
  route: RouteInfo,
): Promise<string> {
  const stable = {
    pool,
    method: request.method,
    path: request.path,
    query: normalizedCacheQuery(request.query ?? {}),
    headers: stableRecord(cacheVaryHeaders(request.headers)),
    route_key: route.routeKey,
    state: cacheStateDiscriminator(route),
  };
  return hashToken(JSON.stringify(stable));
}

export function shouldUseGitHubCache(request: RelayRequest, route: RouteInfo): boolean {
  if (!route.cacheable || route.logs || route.largePayload || route.kind === "rate_limit") {
    return false;
  }
  const headers = request.headers ?? {};
  return headers["if-none-match"] === undefined && headers["if-modified-since"] === undefined;
}

export async function readGitHubCache(
  env: Env,
  cacheKey: string,
  ctx?: ExecutionContext,
): Promise<CachedGitHubResponse | undefined> {
  const edge = await readEdgeJSON<CachedGitHubResponse>(EDGE_CACHE_NAMESPACE, cacheKey);
  if (edge !== undefined) {
    if (freshCachedResponse(edge)) {
      return edge;
    }
    await deleteEdgeJSON(EDGE_CACHE_NAMESPACE, cacheKey);
  }
  const row = await env.DB.prepare(queries.readGitHubCache).bind(cacheKey).first<CacheRow>();
  const cached = cacheRowResponse(row);
  if (cached !== undefined && ctx !== undefined) {
    ctx.waitUntil(writeEdgeCachedResponse(cacheKey, cached));
  }
  return cached;
}

export async function readStaleGitHubCache(
  env: Env,
  cacheKey: string,
  route: RouteInfo,
): Promise<CachedGitHubResponse | undefined> {
  const row = await env.DB.prepare(queries.readGitHubCacheAny).bind(cacheKey).first<CacheRow>();
  if (row === null) {
    return undefined;
  }
  if (!staleCacheAllowed(row, route)) {
    return undefined;
  }
  return cacheRowResponse(row);
}

export function staleCacheSeconds(route: RouteInfo, freshTtlSeconds?: number): number {
  if (
    terminalCIRoute(route) &&
    freshTtlSeconds !== undefined &&
    freshTtlSeconds >= TERMINAL_CI_TTL_DETECTION_SECONDS
  ) {
    return TERMINAL_CI_STALE_SECONDS;
  }
  switch (route.kind) {
    case "run_view":
    case "run_list":
    case "workflow_run_list":
    case "run_jobs":
    case "commit_check_runs":
    case "commit_check_suites":
    case "commit_status":
    case "commit_statuses":
    case "ref_statuses":
    case "job_view":
    case "git_ref":
    case "git_matching_refs":
      return 300;
    case "pr_list":
    case "issue_list":
    case "org_repo_list":
    case "user_repo_list":
      return 600;
    case "pr_view":
    case "issue_view":
    case "pr_files":
    case "pr_commits":
    case "pr_review_comments":
    case "pr_review_comment_list":
    case "pr_review_comment_view":
    case "pr_reviews":
    case "pr_review_view":
    case "pr_review_comments_for_review":
    case "pr_requested_reviewers":
    case "commit_comments":
    case "commit_pulls":
    case "commit_branches_where_head":
    case "repo_comment":
    case "issue_comments":
    case "issue_comment_list":
    case "issue_comment_view":
    case "issue_events":
    case "issue_event_list":
    case "issue_event_view":
    case "issue_labels":
    case "issue_timeline":
    case "label_list":
    case "label_view":
    case "milestone_list":
    case "milestone_view":
    case "issue_reactions":
    case "issue_comment_reactions":
    case "pr_review_comment_reactions":
    case "assignee_list":
    case "assignee_view":
    case "repo_event_list":
    case "network_event_list":
    case "org_event_list":
    case "deployment_list":
      return 3_600;
    case "repo_view":
    case "user_view":
    case "user_org_list":
    case "user_gist_list":
    case "user_follower_list":
    case "user_following_list":
    case "user_event_list":
    case "user_received_event_list":
    case "user_key_list":
    case "user_gpg_key_list":
    case "org_public_member_list":
    case "org_public_member_view":
    case "gist_view":
    case "emoji_list":
    case "github_meta":
    case "license_list":
    case "license_view":
    case "gitignore_template_list":
    case "gitignore_template_view":
    case "repo_readme":
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
    case "commit_list":
    case "compare":
    case "contents":
    case "release_list":
    case "release_view":
    case "release_latest":
    case "release_assets":
    case "release_asset":
    case "repo_stats_contributors":
    case "repo_stats_commit_activity":
    case "repo_stats_code_frequency":
    case "repo_stats_participation":
    case "repo_stats_punch_card":
      return 7_200;
    case "commit_view":
    case "git_blob":
    case "git_commit":
    case "git_tree":
      return 86_400;
    default:
      return 1_800;
  }
}

function cacheRowResponse(row: CacheRow | null): CachedGitHubResponse | undefined {
  if (row === null) {
    return undefined;
  }
  return {
    status: row.status,
    headers: parseJSONRecord(row.response_headers_json),
    body: JSON.parse(row.body_json) as unknown,
    body_encoding: row.body_encoding,
    created_at: row.created_at,
    expires_at: row.expires_at,
    ...(row.identity_id === null || row.identity_kind === null
      ? {}
      : { identity: { id: row.identity_id, kind: row.identity_kind } }),
  };
}

function staleCacheAllowed(row: CacheRow, route: RouteInfo): boolean {
  const createdAt = Date.parse(`${row.created_at}Z`);
  const expiresAt = Date.parse(`${row.expires_at}Z`);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    return false;
  }
  const freshTtlSeconds = Math.max(0, (expiresAt - createdAt) / 1000);
  const maxStaleMs = staleCacheSeconds(route, freshTtlSeconds) * 1000;
  return Date.now() - expiresAt <= maxStaleMs;
}

export async function writeGitHubCache(
  env: Env,
  cacheKey: string,
  request: RelayRequest,
  route: RouteInfo,
  response: GitHubRelayResponse,
  identity?: Identity,
): Promise<void> {
  if (response.status !== 200) {
    return;
  }
  const ttlSeconds = cacheTTLSeconds(route, response);
  const createdAt = sqliteTimestamp(new Date());
  const expiresAt = sqliteTimestamp(new Date(Date.now() + ttlSeconds * 1000));
  const cached: CachedGitHubResponse = {
    ...response,
    body_encoding: response.body_encoding ?? "json",
    created_at: createdAt,
    expires_at: expiresAt,
    ...(identity === undefined ? {} : { identity: { id: identity.id, kind: identity.kind } }),
  };
  await Promise.all([
    env.DB.prepare(queries.writeGitHubCache)
      .bind(
        cacheKey,
        request.pool,
        request.method,
        request.path,
        JSON.stringify(stableRecord(request.query ?? {})),
        JSON.stringify(stableRecord(cacheVaryHeaders(request.headers))),
        route.routeKey,
        route.kind,
        response.status,
        JSON.stringify(response.headers),
        JSON.stringify(response.body),
        response.body_encoding ?? "json",
        identity?.id ?? null,
        identity?.kind ?? null,
        expiresAt,
      )
      .run(),
    writeEdgeCachedResponse(cacheKey, cached),
  ]);
}

function freshCachedResponse(cached: CachedGitHubResponse): boolean {
  if (
    typeof cached.status !== "number" ||
    typeof cached.headers !== "object" ||
    cached.headers === null ||
    typeof cached.created_at !== "string" ||
    typeof cached.expires_at !== "string"
  ) {
    return false;
  }
  const expiresAt = parseSQLiteTimestamp(cached.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function writeEdgeCachedResponse(cacheKey: string, cached: CachedGitHubResponse): Promise<void> {
  const expiresAt = parseSQLiteTimestamp(cached.expires_at);
  const ttlSeconds = Math.floor((expiresAt - Date.now()) / 1000);
  return writeEdgeJSON(EDGE_CACHE_NAMESPACE, cacheKey, cached, ttlSeconds);
}

function parseSQLiteTimestamp(value: string): number {
  return Date.parse(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
}

export function cacheTTLSeconds(route: RouteInfo, response?: GitHubRelayResponse): number {
  switch (route.kind) {
    case "user_view":
      return 3_600;
    case "repo_view":
      return 600;
    case "org_repo_list":
    case "user_repo_list":
      return 600;
    case "user_org_list":
    case "user_gist_list":
    case "user_follower_list":
    case "user_following_list":
    case "user_event_list":
    case "user_received_event_list":
    case "user_key_list":
    case "user_gpg_key_list":
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
      return 3_600;
    case "repo_readme":
      return 3_600;
    case "commit_list":
      return 300;
    case "commit_pulls":
    case "commit_branches_where_head":
      return 300;
    case "commit_view":
    case "git_blob":
    case "git_commit":
    case "git_tree":
      return 86_400;
    case "contents":
      return 3_600;
    case "compare":
      return 300;
    case "release_view":
      return 3_600;
    case "release_latest":
    case "release_list":
      return 300;
    case "workflow_list":
    case "workflow_view":
      return 3_600;
    case "pr_view":
      return closedPR(response) ? 3_600 : 120;
    case "pr_list":
      return 60;
    case "issue_view":
      return closedIssue(response) ? 3_600 : 300;
    case "issue_list":
      return 60;
    case "branch_list":
    case "branch_view":
      return 120;
    case "tag_list":
    case "repo_languages":
    case "repo_contributors":
    case "repo_license":
    case "repo_topics":
    case "community_profile":
    case "fork_list":
    case "stargazer_list":
    case "subscriber_list":
    case "repo_event_list":
    case "network_event_list":
    case "deployment_list":
      return 3_600;
    case "git_ref":
    case "git_matching_refs":
      return 120;
    case "run_view":
      return completedRun(response) ? TERMINAL_CI_TTL_SECONDS : 30;
    case "run_list":
    case "workflow_run_list":
      return completedRunList(response) ? 120 : 30;
    case "run_jobs":
      return completedJobs(response) ? TERMINAL_CI_TTL_SECONDS : 30;
    case "commit_check_runs":
      return completedChecks(response) ? TERMINAL_CI_TTL_SECONDS : 30;
    case "commit_check_suites":
      return completedCheckSuites(response) ? TERMINAL_CI_TTL_SECONDS : 30;
    case "commit_status":
      return completedStatus(response) ? TERMINAL_CI_TTL_SECONDS : 30;
    case "commit_statuses":
    case "ref_statuses":
      return completedStatusList(response) ? TERMINAL_CI_TTL_SECONDS : 30;
    case "job_view":
      return completedJob(response) ? TERMINAL_CI_TTL_SECONDS : 30;
    case "pr_files":
      return stateAwarePRSubresource(route, response) ? 300 : 60;
    case "pr_commits":
    case "pr_review_comments":
    case "pr_review_comment_list":
    case "pr_review_comment_view":
    case "pr_reviews":
    case "pr_review_view":
    case "pr_review_comments_for_review":
    case "pr_requested_reviewers":
    case "commit_comments":
    case "repo_comment":
    case "issue_comments":
    case "issue_comment_list":
    case "issue_comment_view":
    case "issue_events":
    case "issue_event_list":
    case "issue_event_view":
    case "issue_labels":
    case "issue_timeline":
    case "label_list":
    case "label_view":
    case "milestone_list":
    case "milestone_view":
    case "issue_reactions":
    case "issue_comment_reactions":
    case "pr_review_comment_reactions":
    case "assignee_list":
    case "assignee_view":
      return 300;
    case "search_issues":
    case "search_code":
    case "search_commits":
    case "search_repositories":
      return 120;
    case "release_assets":
    case "release_asset":
    case "repo_stats_contributors":
    case "repo_stats_commit_activity":
    case "repo_stats_code_frequency":
    case "repo_stats_participation":
    case "repo_stats_punch_card":
      return 3_600;
    default:
      return 60;
  }
}

function cacheVaryHeaders(headers: RelayRequest["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  const accept = headers?.accept;
  const version = headers?.["x-github-api-version"];
  const publicShape = headers?.["x-octopool-public-shape"];
  if (accept !== undefined && !defaultJSONAccept(accept)) {
    out.accept = accept.toLowerCase();
  }
  if (version !== undefined) {
    out["x-github-api-version"] = version;
  }
  if (publicShape !== undefined) {
    out["x-octopool-public-shape"] = publicShape;
  }
  return out;
}

function normalizedCacheQuery(
  input: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value === undefined || defaultQueryValue(key, value)) {
      continue;
    }
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

function stableRecord(
  input: Record<string, string | string[]> | Record<string, string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value !== undefined) {
      out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

function defaultQueryValue(key: string, value: string | string[]): boolean {
  if (Array.isArray(value)) {
    return false;
  }
  return (key === "page" && value === "1") || (key === "per_page" && value === "30");
}

function defaultJSONAccept(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "application/vnd.github+json" ||
    normalized === "application/json" ||
    normalized === "application/vnd.github.v3+json"
  );
}

function closedPR(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body)) {
    return false;
  }
  return response.body.state === "closed" || typeof response.body.merged_at === "string";
}

function closedIssue(response?: GitHubRelayResponse): boolean {
  return isRecord(response?.body) && response.body.state === "closed";
}

function completedRun(response?: GitHubRelayResponse): boolean {
  return isRecord(response?.body) && response.body.status === "completed";
}

function completedRunList(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body.workflow_runs)) {
    return false;
  }
  return (
    response.body.workflow_runs.length > 0 &&
    response.body.workflow_runs.every((item) => isRecord(item) && item.status === "completed")
  );
}

function completedJobs(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body.jobs)) {
    return false;
  }
  return (
    response.body.jobs.length > 0 &&
    response.body.jobs.every((item) => isRecord(item) && item.status === "completed")
  );
}

function completedJob(response?: GitHubRelayResponse): boolean {
  return isRecord(response?.body) && response.body.status === "completed";
}

function completedChecks(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body.check_runs)) {
    return false;
  }
  return (
    response.body.check_runs.length > 0 &&
    response.body.check_runs.every((item) => isRecord(item) && item.status === "completed")
  );
}

function completedCheckSuites(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body.check_suites)) {
    return false;
  }
  return (
    response.body.check_suites.length > 0 &&
    response.body.check_suites.every((item) => isRecord(item) && item.status === "completed")
  );
}

function completedStatus(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body.statuses)) {
    return false;
  }
  return (
    response.body.statuses.length > 0 &&
    response.body.statuses.every((item) => isRecord(item) && item.state !== "pending")
  );
}

function completedStatusList(response?: GitHubRelayResponse): boolean {
  if (!Array.isArray(response?.body)) {
    return false;
  }
  return (
    response.body.length > 0 &&
    response.body.every((item) => isRecord(item) && item.state !== "pending")
  );
}

function stateAwarePRSubresource(route: RouteInfo, response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) && !Array.isArray(response?.body)) {
    return false;
  }
  return routeStateHint(route) !== undefined && route.state_hint_source === "live";
}

function cacheStateDiscriminator(route: RouteInfo): string | undefined {
  if (!stateAwarePRRoute(route)) {
    return undefined;
  }
  return routeStateHint(route);
}

function routeStateHint(route: RouteInfo): string | undefined {
  return route.state_hint;
}

function stateAwarePRRoute(route: RouteInfo): boolean {
  return route.kind === "pr_files";
}

function terminalCIRoute(route: RouteInfo): boolean {
  switch (route.kind) {
    case "run_view":
    case "run_jobs":
    case "commit_check_runs":
    case "commit_check_suites":
    case "commit_status":
    case "commit_statuses":
    case "ref_statuses":
    case "job_view":
      return true;
    default:
      return false;
  }
}

export async function pruneExpiredGitHubCache(env: Env, limit = 500): Promise<number> {
  const result = await env.DB.prepare(queries.deleteExpiredGitHubCacheBatch).bind(limit).run();
  return result.meta.changes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJSONRecord(raw: string): Record<string, string> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
}

function sqliteTimestamp(value: Date): string {
  return value
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
