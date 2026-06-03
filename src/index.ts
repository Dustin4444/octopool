import {
  authenticateAdmin,
  authenticateCaller,
  githubUserByLogin,
  githubUserFromToken,
  newToken,
  verifyGitHubOrgMember,
  verifyGitHubOrgMemberWithToken,
} from "./auth";
import {
  githubCacheKey,
  readGitHubCache,
  readStaleGitHubCache,
  shouldUseGitHubCache,
  writeGitHubCache,
} from "./cache";
import { dashboardResponse } from "./dashboard";
import { ensurePool, insertAudit, loadIdentities, loadPoolPolicy } from "./db";
import { callGitHub, callPublicGitHub, rateFromHeaders } from "./github";
import { callGitHubWeb } from "./github-web";
import { sanitizeGitHubResponse } from "./github-sanitize";
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
import { githubResponseLocalFallbackReason, localFallbackError } from "./local-fallback";
import { classifyRoute, normalizeRouteKey, validateRelayRequest } from "./policy";
import { ensureCliCaller } from "./callers";
import { PoolCoordinator } from "./pool-coordinator";
import { verifyPRStateHint, verifyPRStateHintLive } from "./pr-state";
import { ensurePublicGitHubRepo } from "./public-repos";
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
import type { GitHubRelayResponse, Identity, RouteInfo, SelectionRequest } from "./types";

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
    identity_usage: identityUsage,
    public_repos: publicRepos,
    coordinator: coordinatorSnapshot,
  });
}

async function dashboardUsage(env: Env, pool: string) {
  const row = await env.DB.prepare(queries.dashboardUsage).bind(pool).first<{
    requests_24h: number;
    errors_24h: number | null;
    cache_hits_24h: number | null;
    cache_stale_24h: number | null;
    cache_misses_24h: number | null;
    cache_bypass_24h: number | null;
    avg_duration_ms_24h: number | null;
    latest_seen_at: string | null;
  }>();
  const cacheHits = row?.cache_hits_24h ?? 0;
  const cacheStale = row?.cache_stale_24h ?? 0;
  const cacheMisses = row?.cache_misses_24h ?? 0;
  const cacheDenominator = cacheHits + cacheStale + cacheMisses;
  return {
    requests_24h: row?.requests_24h ?? 0,
    errors_24h: row?.errors_24h ?? 0,
    cache_hits_24h: cacheHits,
    cache_stale_24h: cacheStale,
    cache_misses_24h: cacheMisses,
    cache_bypass_24h: row?.cache_bypass_24h ?? 0,
    cache_hit_rate_24h: cacheDenominator === 0 ? null : (cacheHits + cacheStale) / cacheDenominator,
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
    duration_ms: number;
  }>();
  return rows.results;
}

async function dashboardRouteUsage(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardRouteUsage).bind(pool).all<{
    route_kind: string;
    requests: number;
    errors: number | null;
    cache_hits: number | null;
    cache_stale: number | null;
    cache_misses: number | null;
    cache_bypass: number | null;
  }>();
  return rows.results.map((row) => {
    const cacheHits = row.cache_hits ?? 0;
    const cacheStale = row.cache_stale ?? 0;
    const cacheMisses = row.cache_misses ?? 0;
    const cacheDenominator = cacheHits + cacheStale + cacheMisses;
    return {
      ...row,
      errors: row.errors ?? 0,
      cache_hits: cacheHits,
      cache_stale: cacheStale,
      cache_misses: cacheMisses,
      cache_bypass: row.cache_bypass ?? 0,
      cache_hit_rate: cacheDenominator === 0 ? null : (cacheHits + cacheStale) / cacheDenominator,
    };
  });
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

async function relayGitHub(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const started = Date.now();
  const body = await parseJsonObject(request);
  const relayRequest = validateRelayRequest(body);
  const caller = await authenticateCaller(request, env, relayRequest.pool);
  const policy = await loadPoolPolicy(env, relayRequest.pool);
  if (policy === null) {
    throw new HttpError(404, "pool_not_found", "Pool not found");
  }
  let route: ReturnType<typeof classifyRoute> | undefined;
  let cacheKey: string | undefined;
  let identity: Identity | undefined;
  let auditCacheStatus: "hit" | "miss" | "bypass" | "stale" | "unknown" = "unknown";
  let auditCacheable = false;
  try {
    route = await verifyPRStateHint(env, relayRequest, classifyRoute(relayRequest, policy));
    const cacheEnabled = shouldUseGitHubCache(relayRequest, route);
    cacheKey = cacheEnabled
      ? await githubCacheKey(relayRequest.pool, relayRequest, route)
      : undefined;
    auditCacheable = cacheKey !== undefined;
    auditCacheStatus = cacheKey === undefined ? "bypass" : "miss";
    if (cacheKey !== undefined) {
      const cached = await readGitHubCache(env, cacheKey);
      if (cached !== undefined) {
        if (await cachedIdentityAvailable(env, relayRequest.pool, route, cached.identity)) {
          return serveCachedGitHubResponse(env, ctx, {
            requestId,
            callerId: caller.id,
            pool: relayRequest.pool,
            route,
            cached,
            started,
            cacheStatus: "hit",
          });
        }
      }
    }
    if (cacheKey !== undefined && route.state_hint_source === "cached") {
      route = await verifyPRStateHintLive(env, relayRequest, route);
      cacheKey = cacheEnabled
        ? await githubCacheKey(relayRequest.pool, relayRequest, route)
        : undefined;
      auditCacheable = cacheKey !== undefined;
      auditCacheStatus = cacheKey === undefined ? "bypass" : "miss";
      if (cacheKey !== undefined) {
        const cached = await readGitHubCache(env, cacheKey);
        if (cached !== undefined) {
          if (await cachedIdentityAvailable(env, relayRequest.pool, route, cached.identity)) {
            return serveCachedGitHubResponse(env, ctx, {
              requestId,
              callerId: caller.id,
              pool: relayRequest.pool,
              route,
              cached,
              started,
              cacheStatus: "hit",
            });
          }
        }
      }
    }
    await ensurePublicGitHubRepo(env, route);
    if (cacheKey === undefined && webOnlyRoute(route)) {
      throw new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
        reason: "web_only_unavailable",
      });
    }
    if (cacheKey !== undefined) {
      const webGitHub = await callGitHubWeb(env, relayRequest, route);
      if (webGitHub !== undefined) {
        const sanitizedWebGitHub = sanitizeGitHubResponse(route, webGitHub);
        ctx.waitUntil(
          Promise.all([
            insertAudit(env, {
              requestId,
              callerId: caller.id,
              pool: relayRequest.pool,
              routeKey: route.routeKey,
              routeKind: route.kind,
              status: sanitizedWebGitHub.status,
              durationMs: Date.now() - started,
              cacheStatus: auditCacheStatus,
              cacheable: auditCacheable,
            }),
            writeGitHubCache(env, cacheKey, relayRequest, route, sanitizedWebGitHub),
          ]),
        );
        return jsonResponse({
          status: sanitizedWebGitHub.status,
          headers: sanitizedWebGitHub.headers,
          body: sanitizedWebGitHub.body,
          body_encoding: sanitizedWebGitHub.body_encoding,
          relay: {
            pool: relayRequest.pool,
            request_id: requestId,
            cacheable: route.cacheable,
            cache: "miss",
            stale_ok: false,
            route_kind: route.kind,
            backend: "web",
          },
        });
      }
      if (webOnlyRoute(route)) {
        throw new HttpError(
          424,
          "fallback_local",
          "Run this request with local GitHub credentials",
          {
            reason: "web_only_unavailable",
          },
        );
      }
    }
    if (route.kind === "user_view") {
      const github = sanitizeGitHubResponse(
        route,
        await callPublicGitHub(env, relayRequest, route),
      );
      const localFallbackReason = githubResponseLocalFallbackReason(
        github.status,
        rateFromHeaders(github.headers),
      );
      if (localFallbackReason !== undefined) {
        throw new HttpError(
          424,
          "fallback_local",
          "Run this request with local GitHub credentials",
          {
            reason: localFallbackReason,
          },
        );
      }
      ctx.waitUntil(
        Promise.all([
          insertAudit(env, {
            requestId,
            callerId: caller.id,
            pool: relayRequest.pool,
            routeKey: route.routeKey,
            routeKind: route.kind,
            status: github.status,
            durationMs: Date.now() - started,
            cacheStatus: auditCacheStatus,
            cacheable: auditCacheable,
          }),
          ...(cacheKey === undefined
            ? []
            : [writeGitHubCache(env, cacheKey, relayRequest, route, github)]),
        ]),
      );
      return jsonResponse({
        status: github.status,
        headers: github.headers,
        body: github.body,
        body_encoding: github.body_encoding,
        relay: {
          pool: relayRequest.pool,
          request_id: requestId,
          cacheable: route.cacheable,
          cache: cacheKey === undefined ? "bypass" : "miss",
          stale_ok: false,
          route_kind: route.kind,
          backend: "github_public",
        },
      });
    }
    const identities = await loadIdentities(env, relayRequest.pool, route);
    if (identities.length === 0) {
      throw new HttpError(503, "no_identity", "No active identity can serve this route");
    }
    const coordinator = env.POOL_COORDINATOR.getByName(`pool:${relayRequest.pool}`);
    const attemptedIdentityIds = new Set<string>();
    let fallbackReason = "identity_pool_depleted";
    for (let attempt = 0; attempt < identities.length; attempt++) {
      const candidates = identities
        .filter((candidate) => !attemptedIdentityIds.has(candidate.id))
        .map((candidate) => ({ id: candidate.id, weight: candidate.weight }));
      if (candidates.length === 0) {
        break;
      }
      const selectionRequest: SelectionRequest = {
        pool: relayRequest.pool,
        routeKey: route.routeKey,
        resource: route.resource,
        candidates,
      };
      const selection = await selectIdentity(coordinator, selectionRequest);
      identity = findIdentity(identities, selection.identityId);
      const rawGitHub = await callGitHub(env, identity, relayRequest, route);
      const github = sanitizeGitHubResponse(route, rawGitHub);
      const rate = rateFromHeaders(github.headers);
      const localFallbackReason = githubResponseLocalFallbackReason(github.status, rate);
      if (localFallbackReason !== undefined) {
        attemptedIdentityIds.add(identity.id);
        fallbackReason = localFallbackReason;
        await coordinator.recordResult({
          identityId: identity.id,
          routeKey: route.routeKey,
          resource: route.resource,
          status: github.status,
          rate,
        });
        continue;
      }
      ctx.waitUntil(
        Promise.all([
          coordinator.recordResult({
            identityId: identity.id,
            routeKey: route.routeKey,
            resource: route.resource,
            status: github.status,
            rate,
          }),
          insertAudit(env, {
            requestId,
            callerId: caller.id,
            pool: relayRequest.pool,
            routeKey: route.routeKey,
            routeKind: route.kind,
            identityId: identity.id,
            status: github.status,
            durationMs: Date.now() - started,
            cacheStatus: auditCacheStatus,
            cacheable: auditCacheable,
          }),
          ...(cacheKey === undefined
            ? []
            : [writeGitHubCache(env, cacheKey, relayRequest, route, github, identity)]),
        ]),
      );
      return jsonResponse({
        status: github.status,
        headers: github.headers,
        body: github.body,
        body_encoding: github.body_encoding,
        identity: {
          id: identity.id,
          kind: identity.kind,
        },
        relay: {
          pool: relayRequest.pool,
          request_id: requestId,
          cacheable: route.cacheable,
          cache: cacheKey === undefined ? "bypass" : "miss",
          stale_ok: false,
          route_kind: route.kind,
          lease_reason: selection.reason,
        },
      });
    }
    if (cacheKey !== undefined && staleFallbackReason(fallbackReason)) {
      const cached = await readStaleGitHubCache(env, cacheKey, route);
      if (
        cached !== undefined &&
        (await staleCachedIdentityAvailable(env, relayRequest.pool, route, cached.identity))
      ) {
        return serveCachedGitHubResponse(env, ctx, {
          requestId,
          callerId: caller.id,
          pool: relayRequest.pool,
          route,
          cached,
          started,
          cacheStatus: "stale",
          staleReason: fallbackReason,
        });
      }
    }
    throw new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
      reason: fallbackReason,
    });
  } catch (error) {
    const reported = localFallbackError(error) ?? error;
    const staleReason = staleFallbackReasonFromError(reported);
    if (cacheKey !== undefined && route !== undefined && staleReason !== undefined) {
      const cached = await readStaleGitHubCache(env, cacheKey, route);
      if (
        cached !== undefined &&
        (await staleCachedIdentityAvailable(env, relayRequest.pool, route, cached.identity))
      ) {
        return serveCachedGitHubResponse(env, ctx, {
          requestId,
          callerId: caller.id,
          pool: relayRequest.pool,
          route,
          cached,
          started,
          cacheStatus: "stale",
          staleReason,
        });
      }
    }
    const audit = auditError(reported);
    ctx.waitUntil(
      insertAudit(env, {
        requestId,
        callerId: caller.id,
        pool: relayRequest.pool,
        routeKey: route?.routeKey ?? normalizeRouteKey(relayRequest.method, relayRequest.path),
        routeKind: route?.kind ?? "denied",
        status: audit.status,
        errorCode: audit.code,
        durationMs: Date.now() - started,
        cacheStatus: auditCacheStatus,
        cacheable: auditCacheable,
        ...(identity === undefined ? {} : { identityId: identity.id }),
      }),
    );
    throw reported;
  }
}

function auditError(error: unknown): { status: number; code: string } {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code };
  }
  return { status: 500, code: "internal_error" };
}

async function serveCachedGitHubResponse(
  env: Env,
  ctx: ExecutionContext,
  params: {
    requestId: string;
    callerId: string;
    pool: string;
    route: RouteInfo;
    cached: GitHubRelayResponse & {
      identity?: Pick<Identity, "id" | "kind">;
      created_at: string;
      expires_at?: string;
    };
    started: number;
    cacheStatus: "hit" | "stale";
    staleReason?: string;
  },
): Promise<Response> {
  await ensurePublicGitHubRepo(env, params.route, params.cached.created_at);
  const sanitizedCached = sanitizeGitHubResponse(params.route, params.cached);
  ctx.waitUntil(
    insertAudit(env, {
      requestId: params.requestId,
      callerId: params.callerId,
      pool: params.pool,
      routeKey: params.route.routeKey,
      routeKind: params.route.kind,
      status: params.cached.status,
      durationMs: Date.now() - params.started,
      ...(params.cached.identity === undefined ? {} : { identityId: params.cached.identity.id }),
      cacheStatus: params.cacheStatus,
      cacheable: true,
    }),
  );
  return jsonResponse({
    status: sanitizedCached.status,
    headers: sanitizedCached.headers,
    body: sanitizedCached.body,
    body_encoding: sanitizedCached.body_encoding,
    identity: params.cached.identity,
    relay: {
      pool: params.pool,
      request_id: params.requestId,
      cacheable: params.route.cacheable,
      cache: params.cacheStatus,
      stale_ok: params.cacheStatus === "stale",
      ...(params.staleReason === undefined ? {} : { stale_reason: params.staleReason }),
      ...(params.cached.expires_at === undefined
        ? {}
        : { cache_expires_at: params.cached.expires_at }),
      route_kind: params.route.kind,
      ...(params.cached.identity === undefined
        ? { backend: params.route.kind === "user_view" ? "github_public" : "web" }
        : {}),
    },
  });
}

function staleFallbackReason(reason: string): boolean {
  switch (reason) {
    case "github_identity_depleted":
    case "github_rate_limited":
    case "identities_cooling_down":
    case "identity_pool_depleted":
    case "no_identity":
      return true;
    default:
      return false;
  }
}

function staleFallbackReasonFromError(error: unknown): string | undefined {
  if (!(error instanceof HttpError)) {
    return undefined;
  }
  if (error.code !== "fallback_local") {
    return staleFallbackReason(error.code) ? error.code : undefined;
  }
  const reason = error.details?.reason;
  return typeof reason === "string" && staleFallbackReason(reason) ? reason : undefined;
}

function webOnlyRoute(route: RouteInfo): boolean {
  return (
    route.kind === "release_list" ||
    route.kind === "release_latest" ||
    route.kind === "release_view" ||
    route.kind === "release_assets" ||
    route.kind === "release_asset" ||
    route.kind === "org_repo_list" ||
    route.kind === "org_event_list" ||
    route.kind === "org_public_member_list" ||
    route.kind === "org_public_member_view" ||
    route.kind === "user_repo_list" ||
    route.kind === "user_org_list" ||
    route.kind === "user_gist_list" ||
    route.kind === "user_follower_list" ||
    route.kind === "user_following_list" ||
    route.kind === "user_event_list" ||
    route.kind === "user_received_event_list" ||
    route.kind === "user_key_list" ||
    route.kind === "user_gpg_key_list" ||
    route.kind === "gist_view" ||
    route.kind === "emoji_list" ||
    route.kind === "github_meta" ||
    route.kind === "license_list" ||
    route.kind === "license_view" ||
    route.kind === "gitignore_template_list" ||
    route.kind === "gitignore_template_view" ||
    route.kind === "search_repositories"
  );
}

async function selectIdentity(
  coordinator: DurableObjectStub<PoolCoordinator>,
  request: SelectionRequest,
) {
  try {
    return await coordinator.selectIdentity(request);
  } catch (error) {
    if (error instanceof Error && error.message.includes("all_identity_candidates_cooling_down")) {
      throw new HttpError(
        503,
        "identities_cooling_down",
        "All identity candidates are cooling down",
      );
    }
    throw error;
  }
}

async function cachedIdentityAvailable(
  env: Env,
  pool: string,
  route: ReturnType<typeof classifyRoute>,
  identity: Pick<Identity, "id" | "kind"> | undefined,
): Promise<boolean> {
  if (identity === undefined) {
    return true;
  }
  if (route.kind === "user_view") {
    return false;
  }
  const activeIdentities = await loadIdentities(env, pool, route);
  if (activeIdentities.length === 0) {
    throw new HttpError(503, "no_identity", "No active identity can serve this route");
  }
  return activeIdentities.some((candidate) => candidate.id === identity.id);
}

async function staleCachedIdentityAvailable(
  env: Env,
  pool: string,
  route: ReturnType<typeof classifyRoute>,
  identity: Pick<Identity, "id" | "kind"> | undefined,
): Promise<boolean> {
  try {
    return await cachedIdentityAvailable(env, pool, route, identity);
  } catch (error) {
    if (error instanceof HttpError && error.code === "no_identity") {
      return false;
    }
    throw error;
  }
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

function findIdentity(identities: Identity[], id: string): Identity {
  const identity = identities.find((candidate) => candidate.id === id);
  if (identity === undefined) {
    throw new HttpError(503, "identity_selection_invalid", "Selected identity is not available");
  }
  return identity;
}
