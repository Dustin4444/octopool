import { afterEach, describe, expect, it, vi } from "vitest";
import { callPublicGitHub } from "../src/github";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";

describe("github api provider", () => {
  const policy = defaultPolicy("openclaw");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches user profiles without pooled authorization", async () => {
    const fetchMock = vi.fn(async () => Response.json({ login: "dependabot[bot]" }));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/users/dependabot%5Bbot%5D",
    });

    await callPublicGitHub(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/users/dependabot%5Bbot%5D",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    REQUEST_TIMEOUT_MS: "15000",
    MAX_RESPONSE_BYTES: "2097152",
    ...overrides,
  } as Env;
}
