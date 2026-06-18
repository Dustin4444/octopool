import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.resolve("migrations")),
          TEST_PAT_PRIMARY: "test-primary-token",
          TEST_PAT_SECONDARY: "test-secondary-token",
          OCTOPOOL_GITHUB_ORG_TOKEN: "test-org-token",
          OCTOPOOL_ADMIN_TOKEN: "test-admin-token",
          GITHUB_OAUTH_CLIENT_SECRET: "test-oauth-secret",
          DEFAULT_LOGIN_POOL: "maintainers",
          PUBLIC_REPO_TTL_SECONDS: "300",
        },
      },
    })),
  ],
  test: {
    include: ["test/e2e/**/*.test.ts"],
    setupFiles: ["./test/e2e/setup.ts"],
  },
});
