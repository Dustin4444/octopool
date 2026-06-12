import { envSecret } from "./auth";
import { queries } from "./generated/sql";
import { HttpError, parsePositiveInt } from "./http";
import type { RouteInfo } from "./types";

type GitHubRepoResponse = {
  private?: unknown;
};

export async function ensurePublicGitHubRepo(
  env: Env,
  route: RouteInfo,
  cacheCreatedAt?: string,
): Promise<void> {
  if (route.owner === undefined || route.repo === undefined) {
    return;
  }
  const owner = route.owner.toLowerCase();
  const repo = route.repo.toLowerCase();
  if (
    cacheCreatedAt !== undefined &&
    (await cachedPublicGitHubRepoCovers(env, route, cacheCreatedAt, true))
  ) {
    return;
  }
  let response = await fetchPublicRepoProof(env, owner, repo, true);
  let historicalProofEligibleResponse: Response | undefined;
  if (!response.ok && publicCheckMayRetryUnauthenticated(response)) {
    if (publicCheckMayUseHistoricalProof(response)) {
      historicalProofEligibleResponse = response;
    }
    response = await fetchPublicRepoProof(env, owner, repo, false);
  }
  if (!response.ok && publicCheckMayUseHistoricalProof(response)) {
    const pageProof = await fetchPublicRepoPageProof(env, owner, repo);
    if (pageProof === false) {
      throw new HttpError(403, "repo_not_public", "Octopool only relays public repositories");
    }
    if (pageProof === true) {
      await storePublicRepoProof(env, owner, repo);
      return;
    }
  }
  if (response.status === 404) {
    throw new HttpError(403, "repo_not_public", "Octopool only relays public repositories");
  }
  if (!response.ok) {
    if (
      cacheCreatedAt !== undefined &&
      (publicCheckMayUseHistoricalProof(response) ||
        historicalProofEligibleResponse !== undefined) &&
      (await cachedPublicGitHubRepoCovers(env, route, cacheCreatedAt))
    ) {
      return;
    }
    throw new HttpError(
      502,
      "repo_public_check_failed",
      `GitHub public repository check failed with ${response.status}`,
    );
  }
  const body = (await response.json()) as GitHubRepoResponse;
  if (body.private !== false) {
    throw new HttpError(403, "repo_not_public", "Octopool only relays public repositories");
  }
  await storePublicRepoProof(env, owner, repo);
}

function fetchPublicRepoProof(
  env: Env,
  owner: string,
  repo: string,
  authenticated: boolean,
): Promise<Response> {
  return fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: publicRepoCheckHeaders(env, authenticated),
      signal: AbortSignal.timeout(parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000)),
    },
  );
}

function publicRepoCheckHeaders(env: Env, authenticated: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "octopool",
    "x-github-api-version": "2022-11-28",
  };
  const token = envSecret(env, "OCTOPOOL_GITHUB_ORG_TOKEN");
  if (authenticated && token !== undefined && token.trim() !== "") {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchPublicRepoPageProof(
  env: Env,
  owner: string,
  repo: string,
): Promise<boolean | undefined> {
  let response: Response;
  try {
    response = await fetch(
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: { accept: "text/html", "user-agent": "octopool" },
        redirect: "manual",
        signal: AbortSignal.timeout(parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000)),
      },
    );
  } catch {
    return undefined;
  }
  if (response.status === 404) {
    return false;
  }
  if (!response.ok || response.body === null) {
    return undefined;
  }
  const marker = 'name="octolytics-dimension-repository_public" content="';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > 524_288) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
      const index = text.indexOf(marker);
      if (index !== -1) {
        const valueStart = index + marker.length;
        const match = /^(true|false)"/.exec(text.slice(valueStart));
        if (match !== null) {
          await reader.cancel();
          return match[1] === "true";
        }
        text = text.slice(index);
        continue;
      }
      text = text.slice(-2048);
    }
  } finally {
    reader.releaseLock();
  }
  return undefined;
}

async function storePublicRepoProof(env: Env, owner: string, repo: string): Promise<void> {
  const ttlSeconds = parsePositiveInt(
    (env as unknown as Record<string, string | undefined>).PUBLIC_REPO_TTL_SECONDS,
    30,
  );
  await env.DB.prepare(queries.upsertPublicRepoProof)
    .bind(owner, repo, `+${ttlSeconds} seconds`)
    .run();
}

function publicCheckMayRetryUnauthenticated(response: Response): boolean {
  return response.status === 401 || publicCheckMayUseHistoricalProof(response);
}

function publicCheckMayUseHistoricalProof(response: Response): boolean {
  const remaining = response.headers.get("x-ratelimit-remaining");
  return (
    response.status >= 500 ||
    response.status === 429 ||
    (response.status === 403 && remaining === "0")
  );
}

async function cachedPublicGitHubRepoCovers(
  env: Env,
  route: RouteInfo,
  cacheCreatedAt: string,
  requireFresh = false,
): Promise<boolean> {
  if (route.owner === undefined || route.repo === undefined) {
    return true;
  }
  const query = requireFresh
    ? queries.freshCoveringPublicRepoProof
    : queries.coveringPublicRepoProof;
  const row = await env.DB.prepare(query)
    .bind(route.owner.toLowerCase(), route.repo.toLowerCase(), cacheCreatedAt)
    .first<{ "1": number }>();
  return row !== null;
}
