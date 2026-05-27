import { describe, expect, it } from "vitest";
import { githubCacheKey, shouldUseGitHubCache } from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";

describe("github cache policy", () => {
  const policy = defaultPolicy("openclaw");

  it("keys equivalent query and header order identically", async () => {
    const left = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341",
      query: { b: "2", a: "1" },
      headers: { accept: "application/vnd.github+json" },
    });
    const right = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341",
      query: { a: "1", b: "2" },
      headers: { accept: "application/vnd.github+json" },
    });
    const route = classifyRoute(left, policy);
    await expect(githubCacheKey("maintainers", left, route)).resolves.toBe(
      await githubCacheKey("maintainers", right, route),
    );
  });

  it("bypasses conditional and rate-limit reads", () => {
    const pr = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341",
      headers: { "if-none-match": "abc" },
    });
    expect(shouldUseGitHubCache(pr, classifyRoute(pr, policy))).toBe(false);

    const rate = validateRelayRequest({ pool: "maintainers", method: "GET", path: "/rate_limit" });
    expect(shouldUseGitHubCache(rate, classifyRoute(rate, policy))).toBe(false);
  });
});
