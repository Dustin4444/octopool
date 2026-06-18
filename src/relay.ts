import { authenticateCaller } from "./auth";
import {
  githubCacheKey,
  readGitHubCache,
  readStaleGitHubCache,
  shouldUseGitHubCache,
  writeGitHubCache,
} from "./cache";
import { coalesceGitHubCacheMiss, finishGitHubCacheFill } from "./cache-coalesce";
import { insertAudit, loadIdentities, loadPoolPolicy } from "./db";
import { callGitHub, callPublicGitHub, rateFromHeaders } from "./github";
import { callGitHubWeb } from "./github-web";
import { sanitizeGitHubResponse } from "./github-sanitize";
import { HttpError, jsonResponse, parseJsonObject } from "./http";
import { githubResponseLocalFallbackReason, localFallbackError } from "./local-fallback";
import { classifyRoute, normalizeRouteKey, validateRelayRequest } from "./policy";
import type { PoolCoordinator } from "./pool-coordinator";
import { verifyPRStateHint, verifyPRStateHintLive } from "./pr-state";
import {
  anonymousGitHubResponseProvesPublicRepo,
  ensurePublicGitHubRepo,
  recordPublicGitHubRepo,
} from "./public-repos";
import { capabilitiesForRouteKind } from "./route-manifest";
import type { GitHubRelayResponse, Identity, RouteInfo, SelectionRequest } from "./types";

export async function relayGitHub(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const started = Date.now();
  const body = await parseJsonObject(request);
  const relayRequest = validateRelayRequest(body);
  const [caller, policy] = await Promise.all([
    authenticateCaller(request, env, relayRequest.pool),
    loadPoolPolicy(env, relayRequest.pool),
  ]);
  if (policy === null) {
    throw new HttpError(404, "pool_not_found", "Pool not found");
  }
  const coordinator = env.POOL_COORDINATOR.getByName(`pool:${relayRequest.pool}`);
  let route: ReturnType<typeof classifyRoute> | undefined;
  let cacheKey: string | undefined;
  let identity: Identity | undefined;
  let cacheFillToken: string | undefined;
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
      const cached = await readGitHubCache(env, cacheKey, ctx);
      if (cached !== undefined) {
        if (await cachedResponseAvailable(env, relayRequest.pool, route, cached, coordinator)) {
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
        const cached = await readGitHubCache(env, cacheKey, ctx);
        if (cached !== undefined) {
          if (await cachedResponseAvailable(env, relayRequest.pool, route, cached, coordinator)) {
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
    if (cacheKey !== undefined) {
      const fill = await coalesceGitHubCacheMiss(env, coordinator, cacheKey);
      cacheFillToken = fill.leaseToken;
      if (
        fill.cached !== undefined &&
        (await cachedResponseAvailable(env, relayRequest.pool, route, fill.cached, coordinator))
      ) {
        return serveCachedGitHubResponse(env, ctx, {
          requestId,
          callerId: caller.id,
          pool: relayRequest.pool,
          route,
          cached: fill.cached,
          started,
          cacheStatus: "hit",
          coalesced: true,
        });
      }
    }
    if (cacheKey !== undefined) {
      const webGitHub = await callGitHubWeb(env, relayRequest, route);
      if (webGitHub !== undefined) {
        const sanitizedWebGitHub = sanitizeGitHubResponse(route, webGitHub);
        if (anonymousGitHubResponseProvesPublicRepo(route)) {
          await Promise.all([
            recordPublicGitHubRepo(env, route),
            publishGitHubCache(env, cacheKey, relayRequest, route, sanitizedWebGitHub),
          ]);
        } else {
          await ensurePublicGitHubRepo(env, route, undefined, coordinator);
          await publishGitHubCache(env, cacheKey, relayRequest, route, sanitizedWebGitHub);
        }
        await finishGitHubCacheFill(coordinator, cacheKey, cacheFillToken);
        ctx.waitUntil(
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
    }
    await ensurePublicGitHubRepo(env, route, undefined, coordinator);
    if (webOnlyRoute(route)) {
      throw new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
        reason: "web_only_unavailable",
      });
    }
    if (capabilitiesForRouteKind(route.kind).fallback === "github_public") {
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
      if (cacheKey !== undefined) {
        await publishGitHubCache(env, cacheKey, relayRequest, route, github);
        await finishGitHubCacheFill(coordinator, cacheKey, cacheFillToken);
      }
      ctx.waitUntil(
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
      if (cacheKey !== undefined) {
        await publishGitHubCache(env, cacheKey, relayRequest, route, github, identity);
        await finishGitHubCacheFill(coordinator, cacheKey, cacheFillToken);
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
        (await cachedResponseAvailable(env, relayRequest.pool, route, cached, coordinator, true))
      ) {
        await finishGitHubCacheFill(coordinator, cacheKey, cacheFillToken);
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
    if (cacheKey !== undefined) {
      await finishGitHubCacheFill(coordinator, cacheKey, cacheFillToken);
    }
    const staleReason = staleFallbackReasonFromError(reported);
    if (cacheKey !== undefined && route !== undefined && staleReason !== undefined) {
      const cached = await readStaleGitHubCache(env, cacheKey, route);
      if (
        cached !== undefined &&
        (await cachedResponseAvailable(env, relayRequest.pool, route, cached, coordinator, true))
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
    const fallbackReason = auditFallbackReason(reported);
    ctx.waitUntil(
      insertAudit(env, {
        requestId,
        callerId: caller.id,
        pool: relayRequest.pool,
        routeKey: route?.routeKey ?? normalizeRouteKey(relayRequest.method, relayRequest.path),
        routeKind: route?.kind ?? "denied",
        status: audit.status,
        errorCode: audit.code,
        ...(fallbackReason === undefined ? {} : { fallbackReason }),
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

function auditFallbackReason(error: unknown): string | undefined {
  if (!(error instanceof HttpError) || error.code !== "fallback_local") {
    return undefined;
  }
  return typeof error.details?.reason === "string" ? error.details.reason : undefined;
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
    coalesced?: boolean;
  },
): Promise<Response> {
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
      ...(params.coalesced === undefined ? {} : { coalesced: params.coalesced }),
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
      ...(params.coalesced === true ? { coalesced: true } : {}),
      ...(params.cached.expires_at === undefined
        ? {}
        : { cache_expires_at: params.cached.expires_at }),
      route_kind: params.route.kind,
      ...(params.cached.identity === undefined
        ? {
            backend:
              capabilitiesForRouteKind(params.route.kind).fallback === "github_public"
                ? "github_public"
                : "web",
          }
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

async function publishGitHubCache(
  env: Env,
  cacheKey: string,
  request: Parameters<typeof writeGitHubCache>[2],
  route: Parameters<typeof writeGitHubCache>[3],
  response: Parameters<typeof writeGitHubCache>[4],
  identity?: Identity,
): Promise<void> {
  try {
    await writeGitHubCache(env, cacheKey, request, route, response, identity);
  } catch (error) {
    console.error("github cache write failed", error);
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
  return capabilitiesForRouteKind(route.kind).fallback === "local";
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
  if (capabilitiesForRouteKind(route.kind).fallback === "github_public") {
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

async function cachedResponseAvailable(
  env: Env,
  pool: string,
  route: ReturnType<typeof classifyRoute>,
  cached: GitHubRelayResponse & {
    identity?: Pick<Identity, "id" | "kind">;
    created_at: string;
  },
  coordinator: DurableObjectStub<PoolCoordinator>,
  stale = false,
): Promise<boolean> {
  const identityAvailable = stale
    ? staleCachedIdentityAvailable(env, pool, route, cached.identity)
    : cachedIdentityAvailable(env, pool, route, cached.identity);
  const [available] = await Promise.all([
    identityAvailable,
    ensurePublicGitHubRepo(env, route, cached.created_at, coordinator),
  ]);
  return available;
}

function findIdentity(identities: Identity[], id: string): Identity {
  const identity = identities.find((candidate) => candidate.id === id);
  if (identity === undefined) {
    throw new HttpError(503, "identity_selection_invalid", "Selected identity is not available");
  }
  return identity;
}
