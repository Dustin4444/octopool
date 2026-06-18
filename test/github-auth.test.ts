import { describe, expect, it } from "vitest";
import { githubToken } from "../src/github-auth";
import type { Identity } from "../src/types";

describe("GitHub identity credentials", () => {
  it("resolves PAT identities from their configured secret", async () => {
    await expect(
      githubToken({ TEST_PAT: "secret-token" } as unknown as Env, identity("pat")),
    ).resolves.toBe("secret-token");
  });

  it("rejects missing identity secrets", async () => {
    await expect(githubToken({} as Env, identity("pat"))).rejects.toMatchObject({
      status: 503,
      code: "identity_secret_missing",
    });
  });

  it("validates GitHub App configuration before token exchange", async () => {
    await expect(githubToken({} as Env, identity("github_app", null))).rejects.toMatchObject({
      code: "github_app_installation_missing",
    });
    await expect(
      githubToken({ TEST_PAT: "key" } as unknown as Env, identity("github_app", 42)),
    ).rejects.toMatchObject({ code: "github_app_id_missing" });
    await expect(
      githubToken(
        {
          TEST_PAT: "-----BEGIN RSA PRIVATE KEY-----\nbad\n-----END RSA PRIVATE KEY-----",
          OCTOPOOL_GITHUB_APP_ID: "7",
        } as unknown as Env,
        identity("github_app", 42),
      ),
    ).rejects.toMatchObject({ code: "github_app_key_format" });
  });
});

function identity(kind: Identity["kind"], installationId: number | null = null): Identity {
  return {
    id: "primary",
    kind,
    login: "primary",
    secret_ref: "TEST_PAT",
    installation_id: installationId,
    weight: 100,
  };
}
