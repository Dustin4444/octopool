import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/route-manifest";

describe("route manifest", () => {
  it("has unique route identities and patterns", () => {
    expect(ROUTES).toHaveLength(112);
    expect(new Set(ROUTES.map((route) => route.kind)).size).toBe(110);
    expect(new Set(ROUTES.map((route) => route.id)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((route) => route.pattern.source)).size).toBe(ROUTES.length);
  });

  it("matches every representative path unambiguously", () => {
    for (const route of ROUTES) {
      const matches = ROUTES.filter((candidate) => candidate.pattern.test(route.example));
      expect(
        matches.map((candidate) => candidate.id),
        route.id,
      ).toEqual([route.id]);
    }
  });
});
