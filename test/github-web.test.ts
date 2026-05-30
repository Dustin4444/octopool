import { afterEach, describe, expect, it, vi } from "vitest";
import { callGitHubWeb } from "../src/github-web";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";

describe("github web provider", () => {
  const policy = defaultPolicy("openclaw");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches public PR diffs without a GitHub API token", async () => {
    const fetchMock = vi.fn(async () => new Response("diff --git a/README.md b/README.md\n"));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(response).toMatchObject({
      status: 200,
      body: "diff --git a/README.md b/README.md\n",
      body_encoding: "text",
      backend: "web",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/openclaw/octopool/pull/12.diff",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("returns API-shaped content JSON from raw.githubusercontent.com", async () => {
    const fetchMock = vi.fn(async () => new Response("hello\n"));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: { ref: "main" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/openclaw/octopool/main/README.md",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
    expect(response?.body).toMatchObject({
      type: "file",
      encoding: "base64",
      name: "README.md",
      path: "README.md",
      sha: "ce013625030ba8dba906f756967f9e9ca394464a",
      content: "aGVsbG8K",
      download_url: "https://raw.githubusercontent.com/openclaw/octopool/main/README.md",
    });
  });

  it("decodes encoded content paths before fetching raw files", async () => {
    const fetchMock = vi.fn(async () => new Response("hello\n"));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/docs/My%20File.md",
      query: { ref: "main" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/openclaw/octopool/main/docs/My%20File.md",
      expect.any(Object),
    );
    expect(response?.body).toMatchObject({
      name: "My File.md",
      path: "docs/My File.md",
      download_url: "https://raw.githubusercontent.com/openclaw/octopool/main/docs/My%20File.md",
    });
  });

  it("encodes decoded compare refs exactly once for web diffs", async () => {
    const fetchMock = vi.fn(async () => new Response("diff --git a/README.md b/README.md\n"));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/compare/main...feature%2Ffoo",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/openclaw/octopool/compare/main...feature%2Ffoo.diff",
      expect.any(Object),
    );
  });

  it("falls through for content reads without an explicit ref", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
    });

    await expect(callGitHubWeb(env(), request, classifyRoute(request, policy))).resolves.toBe(
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through for content reads with unsafe refs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: { ref: "../../steipete/ReleaseBar/main" },
    });

    await expect(callGitHubWeb(env(), request, classifyRoute(request, policy))).resolves.toBe(
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through for non-default content media accepts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: { ref: "main" },
      headers: { accept: "application/vnd.github.raw" },
    });

    await expect(callGitHubWeb(env(), request, classifyRoute(request, policy))).resolves.toBe(
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through on oversized web bodies while streaming", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(2_097_153));
                controller.close();
              },
            }),
          ),
      ),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    await expect(callGitHubWeb(env(), request, classifyRoute(request, policy))).resolves.toBe(
      undefined,
    );
  });

  it("honors the configured response cap for web reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("diff --git a/README.md b/README.md\n")),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    await expect(
      callGitHubWeb(env({ MAX_RESPONSE_BYTES: "8" }), request, classifyRoute(request, policy)),
    ).resolves.toBe(undefined);
  });
});

function env(overrides: Record<string, string> = {}): Env {
  return { REQUEST_TIMEOUT_MS: "15000", ...overrides } as unknown as Env;
}
