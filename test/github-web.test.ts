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

  it("follows GitHub public diff redirects to the patch host", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://patch-diff.githubusercontent.com/raw/openclaw/octopool/pull/12.diff",
          },
        }),
      )
      .mockResolvedValueOnce(new Response("diff --git a/README.md b/README.md\n"));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(response).toMatchObject({ status: 200, backend: "web" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://patch-diff.githubusercontent.com/raw/openclaw/octopool/pull/12.diff",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("prefers exact unauthenticated contents API JSON", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: "file",
            encoding: "base64",
            name: "README.md",
            path: "README.md",
            content: "aGVsbG8K",
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: { ref: "main" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/octopool/contents/README.md?ref=main",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
    expect(response?.body).toMatchObject({
      type: "file",
      encoding: "base64",
      name: "README.md",
      path: "README.md",
      content: "aGVsbG8K",
    });
  });

  it("falls back to raw content extraction when the public contents API is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate limited" }), { status: 403 }),
      )
      .mockResolvedValueOnce(new Response("hello\n"));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/docs/My%20File.md",
      query: { ref: "main" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
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

  it("fetches releases through unauthenticated GitHub API reads", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ tag_name: "v0.2.5", draft: false }]), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/releases",
      query: { per_page: "10" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/octopool/releases?per_page=10",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
    expect(response).toMatchObject({
      status: 200,
      body: [{ tag_name: "v0.2.5", draft: false }],
      backend: "web",
    });
  });

  it("drops draft releases from web-origin release responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { tag_name: "v0.2.5", draft: false },
              { tag_name: "draft", draft: true },
            ]),
          ),
      ),
    );
    const list = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/releases",
    });
    await expect(callGitHubWeb(env(), list, classifyRoute(list, policy))).resolves.toMatchObject({
      body: [{ tag_name: "v0.2.5", draft: false }],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ draft: true }))),
    );
    const view = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/releases/tags/draft",
    });
    await expect(callGitHubWeb(env(), view, classifyRoute(view, policy))).resolves.toBe(undefined);
  });

  it("fetches content reads without an explicit ref through the public contents API", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "README.md" })));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({ body: { name: "README.md" }, backend: "web" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/octopool/contents/README.md",
      expect.any(Object),
    );
  });

  it("uses the public contents API but skips raw extraction for unsafe refs", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "README.md" })));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: { ref: "../../steipete/ReleaseBar/main" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({ body: { name: "README.md" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("fetches repo metadata and branch lists through unauthenticated GitHub API reads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ full_name: "openclaw/octopool" })))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ name: "main" }])));
    vi.stubGlobal("fetch", fetchMock);
    const repo = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool",
    });
    const branches = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/branches",
      query: { per_page: "10" },
    });

    await expect(callGitHubWeb(env(), repo, classifyRoute(repo, policy))).resolves.toMatchObject({
      body: { full_name: "openclaw/octopool" },
      backend: "web",
    });
    await expect(
      callGitHubWeb(env(), branches, classifyRoute(branches, policy)),
    ).resolves.toMatchObject({
      body: [{ name: "main" }],
      backend: "web",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/openclaw/octopool/branches?per_page=10",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("fetches public org, user collection, gist, and repository search reads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: "openclaw" })))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ full_name: "openclaw/octopool" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "abc123", public: true })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ full_name: "openclaw/octopool" }] })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const searchPolicy = { ...policy, allow_search: true };
    const org = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/orgs/openclaw",
    });
    const userRepos = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/users/openperf/repos",
      query: { per_page: "1" },
    });
    const gist = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/gists/abc123",
    });
    const search = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/search/repositories",
      query: { q: "octopool relay" },
    });

    await expect(callGitHubWeb(env(), org, classifyRoute(org, policy))).resolves.toMatchObject({
      body: { login: "openclaw" },
    });
    await expect(
      callGitHubWeb(env(), userRepos, classifyRoute(userRepos, policy)),
    ).resolves.toMatchObject({
      body: [{ full_name: "openclaw/octopool" }],
    });
    await expect(callGitHubWeb(env(), gist, classifyRoute(gist, policy))).resolves.toMatchObject({
      body: { id: "abc123", public: true },
    });
    await expect(
      callGitHubWeb(env(), search, classifyRoute(search, searchPolicy)),
    ).resolves.toMatchObject({
      body: { items: [{ full_name: "openclaw/octopool" }] },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.github.com/search/repositories?q=octopool+relay",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("fetches additional public user and repository collection reads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ login: "steipete" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "event-1" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1, body: "comment" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2, event: "closed" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 0, check_suites: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify([[1682899200, 12]])));
    vi.stubGlobal("fetch", fetchMock);
    const requests = [
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/users/openperf/followers",
        query: { per_page: "1" },
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/users/openperf/events",
        query: { per_page: "1" },
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/issues/comments",
        query: { per_page: "1" },
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/networks/openclaw/octopool/events",
        query: { per_page: "1" },
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/commits/ac49d8e2295a093f168baa45312e1e29238c0351/check-suites",
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/stats/code_frequency",
      }),
    ];

    for (const request of requests) {
      await expect(
        callGitHubWeb(env(), request, classifyRoute(request, policy)),
      ).resolves.toMatchObject({
        backend: "web",
      });
    }
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.github.com/networks/openclaw/octopool/events?per_page=1",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("does not serve secret gist bodies through the public web fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "abc123", public: false }))),
    );
    const gist = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/gists/abc123",
    });

    await expect(callGitHubWeb(env(), gist, classifyRoute(gist, policy))).resolves.toBe(undefined);
  });

  it("preserves GitHub pagination and rate headers on public API reads", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ name: "main" }]), {
          headers: {
            link: '<https://api.github.com/repositories/1/branches?page=2>; rel="next"',
            "x-ratelimit-remaining": "59",
            "x-github-request-id": "req-1",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/branches",
      query: { per_page: "1" },
      headers: { "x-github-api-version": "2024-01-01" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      headers: {
        link: '<https://api.github.com/repositories/1/branches?page=2>; rel="next"',
        "x-ratelimit-remaining": "59",
        "x-github-request-id": "req-1",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/octopool/branches?per_page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-github-api-version": "2024-01-01" }),
      }),
    );
  });

  it("returns empty successful public API responses without falling through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contributors",
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      status: 204,
      body: null,
      body_encoding: "text",
      backend: "web",
    });
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
