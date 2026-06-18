import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker, { PoolCoordinator } from "../../src/index";
import { hashToken } from "../../src/auth";
import type { CoordinatorSnapshot } from "../../src/types";

const CALLER_TOKEN = "caller-token";
const POOL = "maintainers";

type RelayEnvelope = {
  status: number;
  body: unknown;
  identity?: { id: string; kind: string };
  relay: {
    backend?: string;
    cache: string;
    cacheable: boolean;
    route_kind: string;
  };
};

describe("Worker end-to-end relay", () => {
  it("runs the real Worker, D1 migrations, and Durable Object through cache miss and hit", async () => {
    await seedPool();
    const upstream = githubUpstream({
      primary: jsonResponse({ id: 1, full_name: "openclaw/octopool", private: false }),
    });
    vi.stubGlobal("fetch", upstream);

    const first = await relay("/repos/openclaw/octopool");
    expect(first.status).toBe(200);
    const firstBody = await first.json<RelayEnvelope>();
    expect(firstBody).toMatchObject({
      status: 200,
      body: { id: 1, full_name: "openclaw/octopool", private: false },
      identity: { id: "primary", kind: "pat" },
      relay: { cache: "miss", cacheable: true, route_kind: "repo_view" },
    });

    const second = await relay("/repos/openclaw/octopool");
    expect(second.status).toBe(200);
    const secondBody = await second.json<RelayEnvelope>();
    expect(secondBody).toMatchObject({
      status: 200,
      identity: { id: "primary", kind: "pat" },
      relay: { cache: "hit", cacheable: true, route_kind: "repo_view" },
    });
    expect(
      upstream.mock.calls.filter(
        ([request, init]) => bearer(request, init) === "test-primary-token",
      ),
    ).toHaveLength(1);

    const audits = await env.DB.prepare(
      "SELECT cache_status, identity_id, route_kind, status FROM audit_events",
    ).all<{
      cache_status: string;
      identity_id: string | null;
      route_kind: string;
      status: number;
    }>();
    expect(audits.results).toHaveLength(2);
    expect(audits.results).toEqual(
      expect.arrayContaining([
        { cache_status: "miss", identity_id: "primary", route_kind: "repo_view", status: 200 },
        { cache_status: "hit", identity_id: "primary", route_kind: "repo_view", status: 200 },
      ]),
    );
  });

  it("retries a rate-limited identity and persists its coordinator cooldown", async () => {
    await seedPool({ secondary: true });
    const upstream = githubUpstream({
      primary: jsonResponse(
        { message: "rate limited" },
        429,
        rateHeaders({ remaining: 0, retryAfter: 60 }),
      ),
      secondary: jsonResponse(
        { id: 2, full_name: "openclaw/octopool", private: false },
        200,
        rateHeaders({ remaining: 4999 }),
      ),
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/openclaw/octopool");
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      identity: { id: "secondary", kind: "pat" },
      relay: { cache: "miss", route_kind: "repo_view" },
    });
    const tokens = upstream.mock.calls
      .map(([request, init]) => bearer(request, init))
      .filter(Boolean);
    expect(tokens).toContain("test-primary-token");
    expect(tokens).toContain("test-secondary-token");

    const coordinator = env.POOL_COORDINATOR.getByName(`pool:${POOL}`);
    const snapshot = await runInDurableObject(
      coordinator,
      (instance: PoolCoordinator): CoordinatorSnapshot => instance.snapshot(),
    );
    expect(snapshot.cooldowns).toEqual([
      expect.objectContaining({
        identity_id: "primary",
        route_key: "*",
        status: 429,
      }),
    ]);
    expect(snapshot.rates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identity_id: "primary", remaining: 0 }),
        expect.objectContaining({ identity_id: "secondary", remaining: 4999 }),
      ]),
    );
  });

  it("rejects invalid caller authentication before touching GitHub", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/openclaw/octopool", "wrong-token");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_auth" } });
    expect(upstream).not.toHaveBeenCalled();
  });
});

async function relay(path: string, token = CALLER_TOKEN): Promise<Response> {
  return callWorker("/v1/github/request", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ pool: POOL, method: "GET", path }),
  });
}

async function callWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://octopool.dev${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedPool(options: { secondary?: boolean } = {}): Promise<void> {
  const policy = JSON.stringify({
    allowed_owners: ["openclaw"],
    allow_public_repos: true,
    allow_search: true,
    allow_logs: true,
  });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pools (id, name, policy_json) VALUES (?, ?, ?)").bind(
      POOL,
      POOL,
      policy,
    ),
    env.DB.prepare(
      `INSERT INTO callers (
        id, name, token_hash, github_login, org_login, org_verified_at, status, github_user_id,
        dashboard_role
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'active', ?, 'admin')`,
    ).bind("caller", "Caller", await hashToken(CALLER_TOKEN), "caller", "openclaw", 42),
    env.DB.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES (?, ?)").bind(
      "caller",
      POOL,
    ),
    identity("primary", "TEST_PAT_PRIMARY", 200),
    scope("primary"),
    ...(options.secondary === true
      ? [identity("secondary", "TEST_PAT_SECONDARY", 100), scope("secondary")]
      : []),
  ]);
}

function identity(id: string, secretRef: string, weight: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO identities (id, pool_id, kind, login, secret_ref, status, weight)
     VALUES (?, ?, 'pat', ?, ?, 'active', ?)`,
  ).bind(id, POOL, id, secretRef, weight);
}

function scope(identityId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO identity_scopes (identity_id, owner, repo, permission, allow_private)
     VALUES (?, 'openclaw', NULL, 'read', 0)`,
  ).bind(identityId);
}

function githubUpstream(responses: {
  primary: Response;
  secondary?: Response;
}): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    switch (bearer(request)) {
      case "test-org-token":
        return jsonResponse({ private: false });
      case "test-primary-token":
        return responses.primary.clone();
      case "test-secondary-token":
        return (responses.secondary ?? responses.primary).clone();
      default:
        return jsonResponse({ message: "public backend unavailable" }, 503);
    }
  });
}

function bearer(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  const request = new Request(input, init);
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : undefined;
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function rateHeaders(options: { remaining: number; retryAfter?: number }): HeadersInit {
  return {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(options.remaining),
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    "x-ratelimit-resource": "core",
    ...(options.retryAfter === undefined ? {} : { "retry-after": String(options.retryAfter) }),
  };
}
