import { describe, expect, it, vi } from "vitest";
import { loadIdentities } from "../src/db";

describe("identity loading", () => {
  it("uses explicitly broad public PAT identities for public-only routes", async () => {
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => ({
          results: [
            {
              id: "pat_public",
              kind: "pat",
              login: "steipete",
              secret_ref: "OCTOPOOL_PAT_STEIPETE",
              installation_id: null,
              weight: 100,
            },
          ],
        })),
      })),
    }));
    const identities = await loadIdentities(env(prepare), "maintainers", {
      kind: "repo_view",
      owner: "steipete",
      repo: "ReleaseBar",
      publicOnly: true,
      resource: "core",
      routeKey: "GET /repos/steipete/ReleaseBar",
      cacheable: true,
      largePayload: false,
      logs: false,
    });

    expect(identities).toEqual([
      {
        id: "pat_public",
        kind: "pat",
        login: "steipete",
        secret_ref: "OCTOPOOL_PAT_STEIPETE",
        installation_id: null,
        weight: 100,
      },
    ]);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("identity_scopes.owner = '*'"));
  });
});

function env(prepare: ReturnType<typeof vi.fn>): Env {
  return {
    DB: { prepare },
  } as unknown as Env;
}
