import {
  authenticateAdmin,
  authenticateCaller,
  hashToken,
  newToken,
  verifyGitHubOrgMember,
} from "./auth";
import { ensurePool, insertAudit, loadIdentities, loadPoolPolicy } from "./db";
import { callGitHub, rateFromHeaders } from "./github";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  parseJsonObject,
  requireString,
  routeParam,
} from "./http";
import { landingResponse } from "./landing";
import { classifyRoute, normalizeRouteKey, validateRelayRequest } from "./policy";
import { PoolCoordinator } from "./pool-coordinator";
import type { Identity, SelectionRequest } from "./types";

export { PoolCoordinator };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      return await routeRequest(request, env, ctx, requestId);
    } catch (error) {
      return errorResponse(error, requestId);
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
  if (request.method === "GET" && url.pathname === "/") {
    if ((request.headers.get("accept") ?? "").includes("text/html")) {
      return landingResponse();
    }
    return jsonResponse({ ok: true, service: "octopool", request_id: requestId });
  }
  if (request.method === "GET" && url.pathname === "/login/github") {
    return githubLoginRedirect(env, url);
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

function githubLoginRedirect(env: Env, url: URL): Response {
  const clientId = (env as unknown as Record<string, string | undefined>).GITHUB_OAUTH_CLIENT_ID;
  if (clientId === undefined || clientId.trim() === "") {
    return Response.redirect("https://github.com/login", 302);
  }
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId.trim());
  authorize.searchParams.set("redirect_uri", `${url.origin}/login/github/callback`);
  authorize.searchParams.set("scope", "read:org");
  authorize.searchParams.set("allow_signup", "false");
  return Response.redirect(authorize.toString(), 302);
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
  let identity: Identity | undefined;
  try {
    route = classifyRoute(relayRequest, policy);
    const identities = await loadIdentities(env, relayRequest.pool, route);
    if (identities.length === 0) {
      throw new HttpError(503, "no_identity", "No active identity can serve this route");
    }
    const selectionRequest: SelectionRequest = {
      pool: relayRequest.pool,
      routeKey: route.routeKey,
      resource: route.resource,
      candidates: identities.map((candidate) => ({ id: candidate.id, weight: candidate.weight })),
    };
    const coordinator = env.POOL_COORDINATOR.getByName(`pool:${relayRequest.pool}`);
    const selection = await selectIdentity(coordinator, selectionRequest);
    identity = findIdentity(identities, selection.identityId);
    const github = await callGitHub(env, identity, relayRequest, route);
    const rate = rateFromHeaders(github.headers);
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
        stale_ok: false,
        route_kind: route.kind,
        lease_reason: selection.reason,
      },
    });
  } catch (error) {
    const audit = auditError(error);
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
        ...(identity === undefined ? {} : { identityId: identity.id }),
      }),
    );
    throw error;
  }
}

function auditError(error: unknown): { status: number; code: string } {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code };
  }
  return { status: 500, code: "internal_error" };
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

async function poolHealth(env: Env, pool: string): Promise<Response> {
  const identities = await env.DB.prepare(
    `SELECT
       COUNT(*) AS identities_total,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS identities_healthy
     FROM identities
     WHERE pool_id = ?1`,
  )
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

async function createCaller(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonObject(request);
  const pool = requireString(body.pool, "pool");
  const githubLogin = requireString(body.github_login, "github_login");
  const name =
    typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : githubLogin;
  await ensurePool(env, pool);
  const verifiedAt = await verifyGitHubOrgMember(env, githubLogin);
  const token = newToken("op");
  const callerId = `caller_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO callers (id, name, token_hash, github_login, org_login, org_verified_at, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active')`,
  )
    .bind(callerId, name, await hashToken(token), githubLogin, env.ALLOWED_GITHUB_ORG, verifiedAt)
    .run();
  await env.DB.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES (?1, ?2)")
    .bind(callerId, pool)
    .run();
  return jsonResponse(
    {
      caller: {
        id: callerId,
        name,
        github_login: githubLogin,
        org_login: env.ALLOWED_GITHUB_ORG,
        pool,
      },
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
  if (body.kind !== undefined && body.kind !== "pat") {
    throw new HttpError(400, "identity_kind_unsupported", "Only PAT identities are enabled");
  }
  const kind = "pat";
  const weight =
    typeof body.weight === "number" && Number.isInteger(body.weight) ? body.weight : 100;
  const scopes = parseIdentityScopes(body.scopes);
  await ensurePool(env, pool);
  const existing = await env.DB.prepare("SELECT pool_id, kind FROM identities WHERE id = ?1")
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
    env.DB.prepare(
      `INSERT INTO identities (id, pool_id, kind, login, secret_ref, status, weight)
       VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)
       ON CONFLICT(id) DO UPDATE SET
         login = excluded.login,
         secret_ref = excluded.secret_ref,
         status = 'active',
         weight = excluded.weight,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(id, pool, kind, login, secretRef, weight),
    env.DB.prepare("DELETE FROM identity_scopes WHERE identity_id = ?1").bind(id),
    ...scopes.map((scope) =>
      env.DB.prepare(
        `INSERT INTO identity_scopes (identity_id, owner, repo, permission, allow_private)
         VALUES (?1, ?2, ?3, 'read', ?4)`,
      ).bind(id, scope.owner, scope.repo, scope.allowPrivate),
    ),
  ];
  await env.DB.batch(statements);
  return jsonResponse({ identity: { id, pool, kind, login, secret_ref: secretRef, weight } }, 201);
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
    if (repo === null && allowPrivate !== 1) {
      throw new HttpError(
        400,
        "owner_wide_scope_requires_private",
        "Owner-wide scopes must explicitly allow private repositories",
      );
    }
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
