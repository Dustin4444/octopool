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
import { dashboardData } from "./dashboard-data";
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
