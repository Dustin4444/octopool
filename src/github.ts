import { HttpError, parsePositiveInt } from "./http";
import type { Identity, RelayRequest, RouteInfo } from "./types";

type GitHubRelayResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding?: "json" | "text" | "base64";
};

export async function callGitHub(
  env: Env,
  identity: Identity,
  request: RelayRequest,
  route: RouteInfo,
): Promise<GitHubRelayResponse> {
  if (identity.kind !== "pat") {
    throw new HttpError(503, "identity_kind_unsupported", "GitHub App identities are not enabled");
  }
  const token = githubSecret(env, identity.secret_ref);
  const url = githubUrl(request);
  const timeoutMs = parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000);
  const response = await fetch(url, {
    method: "GET",
    headers: githubHeaders(token, request.headers),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    if (route.logs) {
      return fetchGitHubLogRedirect(response, capBytes(env, route), timeoutMs);
    }
    throw new HttpError(502, "github_redirect_denied", "GitHub returned a redirect");
  }
  const bodyBytes = await readBodyCapped(response, capBytes(env, route));
  const contentType = response.headers.get("content-type") ?? "";
  const { body, encoding } = decodeBody(bodyBytes, contentType);
  return {
    status: response.status,
    headers: filteredHeaders(response.headers),
    body,
    body_encoding: encoding,
  };
}

async function fetchGitHubLogRedirect(
  response: Response,
  cap: number,
  timeoutMs: number,
): Promise<GitHubRelayResponse> {
  const location = response.headers.get("location");
  if (location === null) {
    throw new HttpError(502, "github_log_redirect_missing", "GitHub log redirect is missing");
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new HttpError(502, "github_log_redirect_denied", "GitHub log redirect is invalid");
  }
  if (url.protocol !== "https:") {
    throw new HttpError(502, "github_log_redirect_denied", "GitHub log redirect is not HTTPS");
  }
  if (!isAllowedLogRedirectHost(url.hostname)) {
    throw new HttpError(502, "github_log_redirect_denied", "GitHub log redirect host is denied");
  }
  const redirected = await fetch(url.toString(), {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (redirected.status >= 300 && redirected.status < 400) {
    throw new HttpError(502, "github_log_redirect_denied", "GitHub log redirect chained");
  }
  const bodyBytes = await readBodyCapped(redirected, cap);
  const contentType = redirected.headers.get("content-type") ?? "text/plain";
  const { body, encoding } = decodeBody(bodyBytes, contentType);
  return {
    status: redirected.status,
    headers: logRedirectHeaders(response.headers, redirected.headers),
    body,
    body_encoding: encoding,
  };
}

function capBytes(env: Env, route: RouteInfo): number {
  const cap = parsePositiveInt(env.MAX_RESPONSE_BYTES, 2_097_152);
  return route.largePayload ? cap : Math.min(cap, 1_048_576);
}

function isAllowedLogRedirectHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower.endsWith(".actions.githubusercontent.com") || lower.endsWith(".blob.core.windows.net")
  );
}

function logRedirectHeaders(original: Headers, redirected: Headers): Record<string, string> {
  const headers = filteredHeaders(redirected);
  const originalHeaders = filteredHeaders(original);
  for (const key of [
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
    "x-ratelimit-used",
    "x-github-request-id",
  ]) {
    const value = originalHeaders[key];
    if (value !== undefined) {
      headers[key] = value;
    }
  }
  return headers;
}

export function rateFromHeaders(headers: Record<string, string>): {
  limit?: number;
  remaining?: number;
  resetAt?: number;
  retryAfter?: number;
} {
  const out: { limit?: number; remaining?: number; resetAt?: number; retryAfter?: number } = {};
  const limit = parseHeaderInt(headers["x-ratelimit-limit"]);
  const remaining = parseHeaderInt(headers["x-ratelimit-remaining"]);
  const resetAt = parseHeaderInt(headers["x-ratelimit-reset"]);
  const retryAfter = parseHeaderInt(headers["retry-after"]);
  if (limit !== undefined) {
    out.limit = limit;
  }
  if (remaining !== undefined) {
    out.remaining = remaining;
  }
  if (resetAt !== undefined) {
    out.resetAt = resetAt;
  }
  if (retryAfter !== undefined) {
    out.retryAfter = retryAfter;
  }
  return out;
}

function githubSecret(env: Env, secretRef: string): string {
  const value = (env as unknown as Record<string, string | undefined>)[secretRef];
  if (value === undefined || value.trim() === "") {
    throw new HttpError(
      503,
      "identity_secret_missing",
      `Identity secret ${secretRef} is not configured`,
    );
  }
  return value;
}

function githubUrl(request: RelayRequest): string {
  const url = new URL(`https://api.github.com${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function githubHeaders(token: string, input: Record<string, string> | undefined): Headers {
  const headers = new Headers();
  headers.set("accept", input?.accept ?? "application/vnd.github+json");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("user-agent", "octopool");
  headers.set("x-github-api-version", input?.["x-github-api-version"] ?? "2022-11-28");
  if (input?.["if-none-match"] !== undefined) {
    headers.set("if-none-match", input["if-none-match"]);
  }
  if (input?.["if-modified-since"] !== undefined) {
    headers.set("if-modified-since", input["if-modified-since"]);
  }
  return headers;
}

async function readBodyCapped(response: Response, capBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      size += value.byteLength;
      if (size > capBytes) {
        await reader.cancel();
        throw new HttpError(502, "github_response_too_large", "GitHub response exceeded relay cap");
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeBody(
  bytes: Uint8Array,
  contentType: string,
): { body: unknown; encoding: "json" | "text" | "base64" } {
  if (bytes.length === 0) {
    return { body: null, encoding: "text" };
  }
  const text = new TextDecoder().decode(bytes);
  if (contentType.includes("application/json")) {
    try {
      return { body: JSON.parse(text) as unknown, encoding: "json" };
    } catch {
      return { body: text, encoding: "text" };
    }
  }
  if (isMostlyText(bytes)) {
    return { body: text, encoding: "text" };
  }
  return { body: bytesToBase64(bytes), encoding: "base64" };
}

function filteredHeaders(headers: Headers): Record<string, string> {
  const allowed = [
    "content-type",
    "etag",
    "last-modified",
    "link",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
    "x-ratelimit-used",
    "retry-after",
    "x-github-request-id",
  ];
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const value = headers.get(key);
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

function parseHeaderInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isMostlyText(bytes: Uint8Array): boolean {
  for (const byte of bytes.slice(0, 1024)) {
    if (byte === 0) {
      return false;
    }
  }
  return true;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
