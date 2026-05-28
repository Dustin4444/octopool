import { describe, expect, it, vi } from "vitest";
import { errorResponse, HttpError } from "../src/http";
import { rootResponse } from "../src/landing";
import { startGitHubWebLogin } from "../src/web-session";
import { shouldUseWebError, webErrorResponse } from "../src/web-error";

describe("web routing helpers", () => {
  it("serves the landing page by default and JSON only when requested", async () => {
    const html = rootResponse(new Request("https://octopool.dev/"), "req-html");
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("vary")).toBe("Accept");
    expect(await html.text()).toContain("<title>octopool</title>");

    const json = rootResponse(
      new Request("https://octopool.dev/", { headers: { accept: "application/json" } }),
      "req-json",
    );
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(json.headers.get("vary")).toBe("Accept");
    await expect(json.json()).resolves.toMatchObject({ ok: true, service: "octopool" });
  });

  it("renders browser-facing errors as HTML", async () => {
    const request = new Request("https://octopool.dev/login/github/callback", {
      headers: { accept: "text/html" },
    });
    expect(shouldUseWebError(request)).toBe(true);

    const response = webErrorResponse(
      new HttpError(403, "caller_not_provisioned", "Caller is not provisioned for this pool"),
      "req-web",
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Access not provisioned");
    expect(html).toContain("Ask an OpenClaw maintainer");
    expect(html).not.toContain('{"error"');
  });

  it("keeps API errors as JSON even for broad accepts", () => {
    const request = new Request("https://octopool.dev/v1/pools/maintainers/health", {
      headers: { accept: "text/html,application/json" },
    });
    expect(shouldUseWebError(request)).toBe(false);
  });

  it("includes safe error details in API error responses", async () => {
    const response = errorResponse(
      new HttpError(401, "github_auth_failed", "GitHub token check failed with 403", {
        github_rate_limit_reset: "1779928316",
        github_rate_limit_remaining: "0",
      }),
      "req-rate",
    );

    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "github_auth_failed",
        request_id: "req-rate",
        details: {
          github_rate_limit_reset: "1779928316",
          github_rate_limit_remaining: "0",
        },
      },
    });
  });

  it("starts GitHub OAuth with stateless signed state", async () => {
    const env = oauthEnv();
    const response = await startGitHubWebLogin(
      env,
      new URL("https://octopool.dev/login/github?next=/" + "x".repeat(300)),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    expect(location.origin).toBe("https://github.com");
    expect(state).toMatch(/^state\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/);
    expect(response.headers.get("set-cookie")).toContain(encodeURIComponent(state));
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
});

function oauthEnv(): Env & { DB: { prepare: ReturnType<typeof vi.fn> } } {
  const prepare = vi.fn();
  return {
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    DB: { prepare },
  } as unknown as Env & { DB: { prepare: ReturnType<typeof vi.fn> } };
}
