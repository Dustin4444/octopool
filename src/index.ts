import {
  authenticateAdmin,
  authenticateCaller,
  githubUserByLogin,
  githubUserFromToken,
  newToken,
  verifyGitHubOrgMember,
  verifyGitHubOrgMemberWithToken,
} from "./auth";
import { dashboardResponse } from "./dashboard";
import { ensurePool } from "./db";
import { queries } from "./generated/sql";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  parseJsonObject,
  requireString,
  routeParam,
} from "./http";
import { discoveryResponse } from "./discovery";
import { isPublicRequest } from "./hosts";
import { rootResponse } from "./landing";
import { runScheduledMaintenance } from "./maintenance";
import { ensureCliCaller } from "./callers";
import { PoolCoordinator } from "./pool-coordinator";
import { relayGitHub } from "./relay";
import { httpsRedirect, secureResponse } from "./security";
import { parseStatsWindow, poolStats } from "./stats";
import {
  finishGitHubWebLogin,
  logoutWebSession,
  requireDashboardAdmin,
  startGitHubWebLogin,
  webLoginRedirect,
  webMeResponse,
} from "./web-session";
import { publicWebHostRedirect } from "./web-routing";
import { shouldUseWebError, webErrorResponse } from "./web-error";

export { PoolCoordinator };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const redirect = httpsRedirect(request);
    if (redirect !== undefined) {
      return redirect;
    }
    try {
      return secureResponse(request, await routeRequest(request, env, ctx, requestId));
    } catch (error) {
      if (shouldUseWebError(request)) {
        return secureResponse(request, webErrorResponse(error, requestId));
      }
      return secureResponse(request, errorResponse(error, requestId));
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await runScheduledMaintenance(env);
  },
};

async function routeRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/.well-known/octopool") {
    return discoveryResponse(request, env);
  }
  if (request.method === "GET" && url.pathname === "/") {
    return rootResponse(request, requestId, env);
  }
  const webHostRedirect = publicWebHostRedirect(request, url, env);
  if (webHostRedirect !== undefined) {
    return webHostRedirect;
  }
  if (
    isPublicRequest(request, env) &&
    (url.pathname === "/v1/me" || url.pathname === "/v1/dashboard")
  ) {
    throw new HttpError(404, "not_found", "Route not found");
  }
  if (request.method === "GET" && url.pathname === "/login/github") {
    return startGitHubWebLogin(request, env, url);
  }
  if (request.method === "GET" && url.pathname === "/login/github/callback") {
    return finishGitHubWebLogin(request, env, url);
  }
  if (request.method === "GET" && url.pathname === "/logout") {
    return logoutWebSession(request, env);
  }
  if (request.method === "GET" && url.pathname === "/dashboard") {
    try {
      await requireDashboardAdmin(request, env, loginPool(env, undefined));
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        return webLoginRedirect(request, env);
      }
      throw error;
    }
    return dashboardResponse();
  }
  if (request.method === "GET" && url.pathname === "/v1/me") {
    const session = await requireDashboardAdmin(request, env, loginPool(env, undefined));
    return webMeResponse(session);
  }
  if (request.method === "GET" && url.pathname === "/v1/dashboard") {
    return dashboardData(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/login/github-cli") {
    return loginGitHubCLI(request, env);
  }
  if (request.method === "GET" && /^\/v1\/pools\/[^/]+\/stats$/.test(url.pathname)) {
    const pool = routeParam(url.pathname, /^\/v1\/pools\/(?<pool>[^/]+)\/stats$/, "pool");
    const caller = await authenticateCaller(request, env, pool);
    const window = parseStatsWindow(url.searchParams.get("since"));
    return jsonResponse(await poolStats(env, pool, caller, window));
  }
  if (request.method === "GET" && /^\/v1\/pools\/[^/]+\/health$/.test(url.pathname)) {
    const pool = routeParam(url.pathname, /^\/v1\/pools\/(?<pool>[^/]+)\/health$/, "pool");
    await authenticateCaller(request, env, pool);
    return poolHealth(env, pool);
  }
  if (request.method === "POST" && url.pathname === "/v1/github/request") {
    return relayGitHub(request, env, ctx, requestId);
  }
  if (request.method === "POST" && url.pathname === "/v1/admin/callers") {
    await authenticateAdmin(request, env);
    return createCaller(request, env);
  }
  if (request.method === "POST" && /^\/v1\/admin\/pools\/[^/]+\/identities$/.test(url.pathname)) {
    await authenticateAdmin(request, env);
    const pool = routeParam(
      url.pathname,
      /^\/v1\/admin\/pools\/(?<pool>[^/]+)\/identities$/,
      "pool",
    );
    return upsertIdentity(request, env, pool);
  }
  throw new HttpError(404, "not_found", "Route not found");
}

async function dashboardData(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pool = url.searchParams.get("pool")?.trim() || "maintainers";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(pool)) {
    throw new HttpError(400, "pool_invalid", "Pool id is invalid");
  }
  const operator = await requireDashboardAdmin(request, env, pool);
  const coordinator = env.POOL_COORDINATOR.getByName(`pool:${pool}`);
  const [
    identities,
    cache,
    usage,
    users,
    recent,
    routeUsage,
    routeKeys7d,
    errorCodes7d,
    identityUsage,
    publicRepos,
    coordinatorSnapshot,
  ] = await Promise.all([
    dashboardIdentities(env, pool),
    dashboardCache(env, pool),
    dashboardUsage(env, pool),
    dashboardUsers(env, pool),
    dashboardRecent(env, pool),
    dashboardRouteUsage(env, pool),
    dashboardRouteKeys7d(env, pool),
    dashboardErrorCodes7d(env, pool),
    dashboardIdentityUsage(env, pool),
    dashboardPublicRepos(env),
    coordinator.snapshot(),
  ]);
  return jsonResponse({
    generated_at: new Date().toISOString(),
    pool,
    operator: {
      kind: "web",
      github_login: operator.github_login,
      dashboard_role: operator.dashboard_role,
    },
    identities: {
      total: identities.length,
      active: identities.filter((identity) => identity.status === "active").length,
      items: identities,
    },
    cache,
    usage,
    users,
    recent,
    route_usage: routeUsage,
    route_keys_7d: routeKeys7d,
    error_codes_7d: errorCodes7d,
    identity_usage: identityUsage,
    public_repos: publicRepos,
    coordinator: coordinatorSnapshot,
  });
}

async function dashboardUsage(env: Env, pool: string) {
  const row = await env.DB.prepare(queries.dashboardUsage).bind(pool).first<{
    requests_24h: number;
    errors_24h: number | null;
    service_errors_24h: number | null;
    fallbacks_24h: number | null;
    denied_24h: number | null;
    cache_hits_24h: number | null;
    cache_stale_24h: number | null;
    cache_misses_24h: number | null;
    cache_bypass_24h: number | null;
    coalesced_24h: number | null;
    eligible_hits_24h: number | null;
    eligible_misses_24h: number | null;
    avg_duration_ms_24h: number | null;
    latest_seen_at: string | null;
  }>();
  const cacheHits = row?.cache_hits_24h ?? 0;
  const cacheStale = row?.cache_stale_24h ?? 0;
  const cacheMisses = row?.cache_misses_24h ?? 0;
  const cacheDenominator = cacheHits + cacheStale + cacheMisses;
  const eligibleHits = row?.eligible_hits_24h ?? 0;
  const eligibleMisses = row?.eligible_misses_24h ?? 0;
  const eligibleDenominator = eligibleHits + eligibleMisses;
  return {
    requests_24h: row?.requests_24h ?? 0,
    errors_24h: row?.errors_24h ?? 0,
    service_errors_24h: row?.service_errors_24h ?? 0,
    fallbacks_24h: row?.fallbacks_24h ?? 0,
    denied_24h: row?.denied_24h ?? 0,
    cache_hits_24h: cacheHits,
    cache_stale_24h: cacheStale,
    cache_misses_24h: cacheMisses,
    cache_bypass_24h: row?.cache_bypass_24h ?? 0,
    coalesced_24h: row?.coalesced_24h ?? 0,
    cache_hit_rate_24h: cacheDenominator === 0 ? null : (cacheHits + cacheStale) / cacheDenominator,
    eligible_cache_hit_rate_24h:
      eligibleDenominator === 0 ? null : eligibleHits / eligibleDenominator,
    avg_duration_ms_24h: row?.avg_duration_ms_24h ?? null,
    latest_seen_at: row?.latest_seen_at ?? null,
  };
}

async function dashboardIdentities(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardIdentities).bind(pool).all<{
    id: string;
    kind: string;
    login: string;
    installation_id: number | null;
    status: string;
    weight: number;
    updated_at: string;
  }>();
  return rows.results;
}

async function dashboardCache(env: Env, pool: string) {
  const row = await env.DB.prepare(queries.dashboardCache).bind(pool).first<{
    total_entries: number;
    fresh_entries: number | null;
    expired_entries: number | null;
    body_bytes: number | null;
    oldest_created_at: string | null;
    newest_created_at: string | null;
  }>();
  return {
    total_entries: row?.total_entries ?? 0,
    fresh_entries: row?.fresh_entries ?? 0,
    expired_entries: row?.expired_entries ?? 0,
    body_bytes: row?.body_bytes ?? 0,
    oldest_created_at: row?.oldest_created_at ?? null,
    newest_created_at: row?.newest_created_at ?? null,
    routes: await dashboardCacheRoutes(env, pool),
  };
}

async function dashboardCacheRoutes(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardCacheRoutes).bind(pool).all<{
    route_kind: string;
    entries: number;
    fresh_entries: number | null;
    latest_created_at: string | null;
  }>();
  return rows.results.map((row) => ({
    ...row,
    fresh_entries: row.fresh_entries ?? 0,
  }));
}

async function dashboardUsers(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardUsers).bind(pool).all<{
    id: string;
    name: string;
    github_login: string;
    requests: number;
    errors: number | null;
    avg_duration_ms: number | null;
    last_seen: string | null;
  }>();
  return rows.results.map((row) => ({ ...row, errors: row.errors ?? 0 }));
}

async function dashboardRecent(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardRecent).bind(pool).all<{
    created_at: string;
    github_login: string;
    route_kind: string;
    route_key: string;
    identity_id: string | null;
    status: number;
    error_code: string | null;
    fallback_reason: string | null;
    duration_ms: number;
  }>();
  return rows.results;
}

async function dashboardRouteUsage(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardRouteUsage).bind(pool).all<{
    route_kind: string;
    requests: number;
    errors: number | null;
    service_errors: number | null;
    fallbacks: number | null;
    cache_hits: number | null;
    cache_stale: number | null;
    cache_misses: number | null;
    cache_bypass: number | null;
    coalesced: number | null;
    eligible_hits: number | null;
    eligible_misses: number | null;
  }>();
  return rows.results.map((row) => {
    const cacheHits = row.cache_hits ?? 0;
    const cacheStale = row.cache_stale ?? 0;
    const cacheMisses = row.cache_misses ?? 0;
    const cacheDenominator = cacheHits + cacheStale + cacheMisses;
    const eligibleHits = row.eligible_hits ?? 0;
    const eligibleMisses = row.eligible_misses ?? 0;
    const eligibleDenominator = eligibleHits + eligibleMisses;
    return {
      ...row,
      errors: row.errors ?? 0,
      service_errors: row.service_errors ?? 0,
      fallbacks: row.fallbacks ?? 0,
      cache_hits: cacheHits,
      cache_stale: cacheStale,
      cache_misses: cacheMisses,
      cache_bypass: row.cache_bypass ?? 0,
      coalesced: row.coalesced ?? 0,
      cache_hit_rate: cacheDenominator === 0 ? null : (cacheHits + cacheStale) / cacheDenominator,
      eligible_cache_hit_rate:
        eligibleDenominator === 0 ? null : eligibleHits / eligibleDenominator,
    };
  });
}

async function dashboardRouteKeys7d(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardRouteKeys7d).bind(pool).all<{
    route_kind: string;
    route_key: string;
    requests: number;
    cache_hits: number | null;
    cache_misses: number | null;
    coalesced: number | null;
    fallbacks: number | null;
    service_errors: number | null;
    latest_seen_at: string | null;
  }>();
  return rows.results.map((row) => ({
    ...row,
    cache_hits: row.cache_hits ?? 0,
    cache_misses: row.cache_misses ?? 0,
    coalesced: row.coalesced ?? 0,
    fallbacks: row.fallbacks ?? 0,
    service_errors: row.service_errors ?? 0,
  }));
}

async function dashboardErrorCodes7d(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardErrorCodes7d).bind(pool).all<{
    outcome: string;
    route_kind: string;
    requests: number;
    latest_seen_at: string | null;
  }>();
  return rows.results;
}

async function dashboardIdentityUsage(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardIdentityUsage)
    .bind(pool)
    .all<{ identity_id: string; requests: number; errors: number | null }>();
  return rows.results.map((row) => ({ ...row, errors: row.errors ?? 0 }));
}

async function dashboardPublicRepos(env: Env) {
  const row = await env.DB.prepare(queries.dashboardPublicRepos).first<{
    total_entries: number;
    fresh_entries: number | null;
    newest_checked_at: string | null;
  }>();
  return {
    total_entries: row?.total_entries ?? 0,
    fresh_entries: row?.fresh_entries ?? 0,
    newest_checked_at: row?.newest_checked_at ?? null,
  };
}

async function poolHealth(env: Env, pool: string): Promise<Response> {
  const identities = await env.DB.prepare(queries.poolHealth)
    .bind(pool)
    .first<{ identities_total: number; identities_healthy: number | null }>();
  if (identities === null) {
    throw new HttpError(404, "pool_not_found", "Pool not found");
  }
  return jsonResponse({
    pool,
    identities_total: identities.identities_total,
    identities_healthy: identities.identities_healthy ?? 0,
    policy_version: 1,
  });
}

async function loginGitHubCLI(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonObject(request);
  const githubToken = requireString(body.github_token, "github_token");
  const pool = loginPool(env, body.pool);
  const user = await githubUserFromToken(githubToken);
  const verifiedAt = await verifyGitHubOrgMemberWithToken(env, githubToken, user.login);
  const token = newToken("op");
  const caller = await ensureCliCaller(env, pool, user, verifiedAt, token);
  return jsonResponse(
    {
      caller,
      token,
    },
    201,
  );
}

function loginPool(env: Env, requested: unknown): string {
  const configured = (env as unknown as Record<string, string | undefined>).DEFAULT_LOGIN_POOL;
  const allowed =
    configured === undefined || configured.trim() === "" ? "maintainers" : configured.trim();
  if (requested === undefined || requested === null || requested === "") {
    return allowed;
  }
  if (typeof requested !== "string" || requested.trim() !== allowed) {
    throw new HttpError(403, "pool_denied", "CLI login cannot self-grant this pool");
  }
  return allowed;
}

async function createCaller(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonObject(request);
  const pool = requireString(body.pool, "pool");
  const githubLogin = requireString(body.github_login, "github_login");
  const name =
    typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : githubLogin;
  await ensurePool(env, pool);
  const verifiedAt = await verifyGitHubOrgMember(env, githubLogin);
  const githubUser = await githubUserByLogin(githubLogin);
  const token = newToken("op");
  const caller = await ensureCliCaller(env, pool, { ...githubUser, name }, verifiedAt, token);
  return jsonResponse(
    {
      caller,
      token,
    },
    201,
  );
}

async function upsertIdentity(request: Request, env: Env, pool: string): Promise<Response> {
  const body = await parseJsonObject(request);
  const id = requireString(body.id, "id");
  const login = requireString(body.login, "login");
  const secretRef = requireString(body.secret_ref, "secret_ref");
  if (body.kind !== undefined && body.kind !== "pat" && body.kind !== "github_app") {
    throw new HttpError(
      400,
      "identity_kind_unsupported",
      "Only PAT and GitHub App identities are enabled",
    );
  }
  const kind = body.kind === "github_app" ? "github_app" : "pat";
  const installationId =
    typeof body.installation_id === "number" && Number.isInteger(body.installation_id)
      ? body.installation_id
      : null;
  if (kind === "github_app" && (installationId === null || installationId <= 0)) {
    throw new HttpError(
      400,
      "installation_id_required",
      "GitHub App identities require a positive installation_id",
    );
  }
  const weight =
    typeof body.weight === "number" && Number.isInteger(body.weight) ? body.weight : 100;
  const scopes = parseIdentityScopes(body.scopes);
  await ensurePool(env, pool);
  const existing = await env.DB.prepare(queries.getIdentityPoolKind)
    .bind(id)
    .first<{ pool_id: string; kind: string }>();
  if (existing !== null && (existing.pool_id !== pool || existing.kind !== kind)) {
    throw new HttpError(
      409,
      "identity_conflict",
      "Identity id already exists for a different pool or kind",
    );
  }
  const statements = [
    env.DB.prepare(queries.upsertIdentity).bind(
      id,
      pool,
      kind,
      login,
      secretRef,
      installationId,
      weight,
    ),
    env.DB.prepare(queries.deleteIdentityScopes).bind(id),
    ...scopes.map((scope) =>
      env.DB.prepare(queries.insertIdentityScope).bind(
        id,
        scope.owner,
        scope.repo,
        scope.allowPrivate,
      ),
    ),
  ];
  await env.DB.batch(statements);
  return jsonResponse(
    {
      identity: {
        id,
        pool,
        kind,
        login,
        secret_ref: secretRef,
        installation_id: installationId,
        weight,
      },
    },
    201,
  );
}

function parseIdentityScopes(rawScopes: unknown): {
  owner: string;
  repo: string | null;
  allowPrivate: number;
}[] {
  const scopes = Array.isArray(rawScopes) ? rawScopes : [];
  const out: { owner: string; repo: string | null; allowPrivate: number }[] = [];
  for (const scope of scopes) {
    if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
      continue;
    }
    const owner = typeof scope.owner === "string" ? scope.owner.trim() : "";
    if (owner === "") {
      continue;
    }
    const repo =
      typeof scope.repo === "string" && scope.repo.trim() !== "" ? scope.repo.trim() : null;
    const allowPrivate = scope.allow_private === true ? 1 : 0;
    out.push({ owner, repo, allowPrivate });
  }
  return out;
}
