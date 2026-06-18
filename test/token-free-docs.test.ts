import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicApiRoute } from "../src/github-web";
import { ROUTES, type RouteKind } from "../src/route-manifest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("token-free endpoint documentation", () => {
  it("matches every implemented anonymous API route", () => {
    const docs = readFileSync(path.join(root, "docs/token-free.md"), "utf8");

    const documented = new Set(
      section(docs, "token-free-api-routes")
        .match(/^GET (\/\S+)$/gm)
        ?.map((line) => line.slice("GET ".length)) ?? [],
    );
    const specialTokenFreeKinds = new Set<RouteKind>([
      "user_view",
      "release_list",
      "release_latest",
      "release_view",
    ]);
    const implemented = new Set(
      ROUTES.filter((route) => publicApiRoute(route) || specialTokenFreeKinds.has(route.kind)).map(
        (route) => normalizeRoute(route.template),
      ),
    );

    expect([...documented].sort()).toEqual([...implemented].sort());
  });

  it("documents every no-API-quota transport family", () => {
    const docs = readFileSync(path.join(root, "docs/token-free.md"), "utf8");
    const githubWeb = readFileSync(path.join(root, "src/github-web.ts"), "utf8");
    for (const source of [
      "patch-diff.githubusercontent.com",
      "raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}",
      "{repo}.git/info/refs?service=git-upload-pack",
      "/issues?q=is%3Aissue",
      "/actions/runs/{id}/job_groups_batch?attempt=1",
      "/actions/workflows_partial?query=&page={page}",
      "/releases/tag/{tag}",
    ]) {
      expect(docs).toContain(source);
    }
    for (const match of githubWeb.matchAll(/const [A-Z_]+_SHAPE = "([^"]+)"/g)) {
      expect(docs).toContain(match[1]!);
    }
  });
});

function section(input: string, name: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const startIndex = input.indexOf(start);
  const endIndex = input.indexOf(end);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return input.slice(startIndex + start.length, endIndex);
}

function normalizeRoute(value: string): string {
  const names: Record<string, string> = {
    compare: "comparison",
    contentPath: "path",
    gistId: "gist",
    gitRef: "ref",
    readmeDir: "dir",
  };
  return value.replace(/\{([^}]+)\}/g, (_, name: string) => `{${names[name] ?? name}}`);
}
