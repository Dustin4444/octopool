import {
  ensureFreshOrgMembership,
  envSecret,
  githubUserFromToken,
  hashToken,
  newToken,
  verifyGitHubOrgMember,
} from "./auth";
import { HttpError, jsonResponse } from "./http";
import type { WebSession } from "./types";

const SESSION_COOKIE = "octopool_session";
const STATE_COOKIE = "octopool_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const STATE_TTL_SECONDS = 60 * 10;

export async function startGitHubWebLogin(env: Env, url: URL): Promise<Response> {
  const clientId = envSecret(env, "GITHUB_OAUTH_CLIENT_ID")?.trim();
  if (clientId === undefined || clientId === "") {
    return Response.redirect("https://github.com/login", 302);
  }
  const state = newToken("state");
  const next = safeNextPath(url.searchParams.get("next"));
  await env.DB.prepare(
    `INSERT INTO oauth_states (state_hash, next_path, expires_at)
     VALUES (?1, ?2, datetime('now', ?3))`,
  )
    .bind(await hashToken(state), next, `+${STATE_TTL_SECONDS} seconds`)
    .run();

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", `${url.origin}/login/github/callback`);
  authorize.searchParams.set("scope", "read:org");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");

  return redirectWithCookies(authorize.toString(), [
    cookie(STATE_COOKIE, state, {
      maxAge: STATE_TTL_SECONDS,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/login/github",
    }),
  ]);
}

export async function finishGitHubWebLogin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error !== null) {
    throw new HttpError(401, "github_login_denied", "GitHub login was denied");
  }
  const code = url.searchParams.get("code")?.trim();
  const state = url.searchParams.get("state")?.trim();
  const stateCookie = readCookie(request, STATE_COOKIE);
  if (code === undefined || code === "" || state === undefined || state === "") {
    throw new HttpError(400, "github_callback_invalid", "GitHub callback is incomplete");
  }
  if (stateCookie === undefined || stateCookie !== state) {
    throw new HttpError(401, "github_state_invalid", "GitHub login state is invalid");
  }

  const stateHash = await hashToken(state);
  const stateRow = await env.DB.prepare(
    `SELECT next_path
     FROM oauth_states
     WHERE state_hash = ?1
       AND expires_at > CURRENT_TIMESTAMP
     LIMIT 1`,
  )
    .bind(stateHash)
    .first<{ next_path: string }>();
  await env.DB.prepare(
    "DELETE FROM oauth_states WHERE state_hash = ?1 OR expires_at <= CURRENT_TIMESTAMP",
  )
    .bind(stateHash)
    .run();
  if (stateRow === null) {
    throw new HttpError(401, "github_state_expired", "GitHub login state expired");
  }

  const githubToken = await exchangeGitHubCode(env, url, code);
  const user = await githubUserFromToken(githubToken);
  const verifiedAt = await verifyGitHubOrgMember(env, user.login);
  const pool = loginPool(env);
  const caller = await env.DB.prepare(
    `SELECT callers.id, callers.dashboard_role
     FROM callers
     JOIN caller_pools ON caller_pools.caller_id = callers.id
     WHERE callers.github_user_id = ?1
       AND callers.org_login = ?2
       AND callers.status = 'active'
       AND caller_pools.pool_id = ?3
     LIMIT 1`,
  )
    .bind(user.id, env.ALLOWED_GITHUB_ORG, pool)
    .first<{ id: string; dashboard_role: "none" | "admin" }>();
  if (caller === null) {
    throw new HttpError(403, "caller_not_provisioned", "Caller is not provisioned for this pool");
  }

  const session = newToken("sess");
  const expires = sqliteTimestamp(Date.now() + SESSION_TTL_SECONDS * 1000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE callers
       SET name = ?1,
           github_login = ?2,
           github_user_id = ?3,
           org_verified_at = ?4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?5`,
    ).bind(user.name ?? user.login, user.login, user.id, verifiedAt, caller.id),
    env.DB.prepare(
      `INSERT INTO web_sessions (session_hash, caller_id, expires_at)
       VALUES (?1, ?2, ?3)`,
    ).bind(await hashToken(session), caller.id, expires),
  ]);

  return redirectWithCookies(safeNextPath(stateRow.next_path), [
    expiredCookie(STATE_COOKIE, "/login/github"),
    cookie(SESSION_COOKIE, session, {
      maxAge: SESSION_TTL_SECONDS,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
    }),
  ]);
}

export async function logoutWebSession(request: Request, env: Env): Promise<Response> {
  const session = readCookie(request, SESSION_COOKIE);
  if (session !== undefined) {
    await env.DB.prepare("DELETE FROM web_sessions WHERE session_hash = ?1")
      .bind(await hashToken(session))
      .run();
  }
  return redirectWithCookies("/", [expiredCookie(SESSION_COOKIE, "/")]);
}

export async function authenticateWebSession(
  request: Request,
  env: Env,
  pool: string,
): Promise<WebSession> {
  const session = readCookie(request, SESSION_COOKIE);
  if (session === undefined || session === "") {
    throw new HttpError(401, "missing_web_session", "Missing web session");
  }
  const row = await env.DB.prepare(
    `SELECT
       callers.id,
       callers.name,
       callers.github_login,
       callers.org_login,
       callers.org_verified_at,
       callers.dashboard_role,
       web_sessions.expires_at
     FROM web_sessions
     JOIN callers ON callers.id = web_sessions.caller_id
     WHERE web_sessions.session_hash = ?1
       AND web_sessions.expires_at > CURRENT_TIMESTAMP
       AND callers.status = 'active'
       AND callers.org_login = ?2
     LIMIT 1`,
  )
    .bind(await hashToken(session), env.ALLOWED_GITHUB_ORG)
    .first<WebSession>();
  if (row === null) {
    throw new HttpError(401, "invalid_web_session", "Invalid web session");
  }
  await ensureFreshOrgMembership(env, row);
  const grant = await env.DB.prepare(
    "SELECT 1 FROM caller_pools WHERE caller_id = ?1 AND pool_id = ?2 LIMIT 1",
  )
    .bind(row.id, pool)
    .first();
  if (grant === null) {
    throw new HttpError(403, "pool_denied", "Web session is not granted for this pool");
  }
  await env.DB.prepare(
    "UPDATE web_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE session_hash = ?1",
  )
    .bind(await hashToken(session))
    .run();
  return row;
}

export async function requireDashboardAdmin(
  request: Request,
  env: Env,
  pool: string,
): Promise<WebSession> {
  const session = await authenticateWebSession(request, env, pool);
  if (session.dashboard_role !== "admin") {
    throw new HttpError(403, "dashboard_denied", "Dashboard access requires admin role");
  }
  return session;
}

export function webLoginRedirect(request: Request): Response {
  const url = new URL(request.url);
  return Response.redirect(
    `${url.origin}/login/github?next=${encodeURIComponent(url.pathname)}`,
    302,
  );
}

export function webMeResponse(session: WebSession): Response {
  return jsonResponse({
    caller: {
      id: session.id,
      name: session.name,
      github_login: session.github_login,
      org_login: session.org_login,
      dashboard_role: session.dashboard_role,
    },
    expires_at: session.expires_at,
  });
}

function loginPool(env: Env): string {
  const configured = envSecret(env, "DEFAULT_LOGIN_POOL");
  return configured === undefined || configured.trim() === "" ? "maintainers" : configured.trim();
}

async function exchangeGitHubCode(env: Env, url: URL, code: string): Promise<string> {
  const clientId = envSecret(env, "GITHUB_OAUTH_CLIENT_ID")?.trim();
  const clientSecret = envSecret(env, "GITHUB_OAUTH_CLIENT_SECRET")?.trim();
  if (
    clientId === undefined ||
    clientId === "" ||
    clientSecret === undefined ||
    clientSecret === ""
  ) {
    throw new HttpError(503, "github_oauth_unconfigured", "GitHub OAuth is not configured");
  }
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "octopool",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${url.origin}/login/github/callback`,
    }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(502, "github_oauth_failed", "GitHub OAuth token exchange failed");
  }
  const accessToken = (body as { access_token?: unknown }).access_token;
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    throw new HttpError(502, "github_oauth_failed", "GitHub OAuth token response was incomplete");
  }
  return accessToken;
}

function safeNextPath(value: string | null): string {
  if (value === null || value.trim() === "") {
    return "/dashboard";
  }
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("\n")
  ) {
    return "/dashboard";
  }
  return value;
}

function sqliteTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19);
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return undefined;
}

function redirectWithCookies(location: string, cookies: string[]): Response {
  return new Response(null, {
    status: 302,
    headers: [
      ["location", location],
      ...cookies.map((value): [string, string] => ["set-cookie", value]),
    ],
  });
}

function cookie(
  name: string,
  value: string,
  options: { maxAge: number; httpOnly: boolean; secure: boolean; sameSite: "Lax"; path: string },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    "SameSite=Lax",
    options.httpOnly ? "HttpOnly" : "",
    options.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function expiredCookie(name: string, path: string): string {
  return `${name}=; Max-Age=0; Path=${path}; SameSite=Lax; HttpOnly; Secure`;
}
