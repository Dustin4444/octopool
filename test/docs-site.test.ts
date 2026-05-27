import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("docs site generator", () => {
  it("keeps wrapped markdown list items in one list item", () => {
    execFileSync("node", ["scripts/build-docs-site.mjs"], { cwd: root, stdio: "pipe" });

    const index = readFileSync(path.join(root, "dist/docs-site/index.html"), "utf8");
    expect(index).toContain(
      '<li><a href="relay.html">GitHub read relay</a> — the <code>POST /v1/github/request</code> endpoint, supported routes, response envelope, policy gates, and safety limits.</li>',
    );
    expect(index).toContain(
      '<li><a href="gitcrawl-migrate.html">Gitcrawl gh migration</a> — moving the <code>gh</code> cache surface out of gitcrawl into Octopool.</li>',
    );
    expect(index).not.toContain("</ul>\n<p>routes,");
    expect(index).not.toContain("</ul>\n<p>gitcrawl into Octopool.");
  });
});
