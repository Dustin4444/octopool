import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http";
import { rootResponse } from "../src/landing";
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
});
