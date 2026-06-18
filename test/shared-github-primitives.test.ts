import { describe, expect, it, vi } from "vitest";
import { base64ToBytes, base64ToBytesSafe, bytesToBase64, bytesToBase64URL } from "../src/encoding";
import { decodeURIComponentSafe, encodedPathSegments } from "../src/github-path";
import { readBodyCapped } from "../src/response-body";

describe("shared GitHub primitives", () => {
  it("round-trips standard and URL-safe base64", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x61]);

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(base64ToBytesSafe(bytesToBase64URL(bytes))).toEqual(bytes);
    expect(base64ToBytesSafe("not base64!")).toBeUndefined();
  });

  it("encodes slash-separated GitHub path components without losing boundaries", () => {
    expect(encodedPathSegments(["openclaw", "octo pool", "refs/heads/main"])).toBe(
      "openclaw/octo%20pool/refs/heads/main",
    );
    expect(decodeURIComponentSafe("dependabot%5Bbot%5D")).toBe("dependabot[bot]");
    expect(decodeURIComponentSafe("bad%2")).toBe("bad%2");
  });

  it("combines streamed chunks within the cap", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    );

    await expect(readBodyCapped(response, 3, () => new Error("too large"))).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("cancels an oversized stream and preserves the configured error", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        },
        cancel,
      }),
    );

    await expect(readBodyCapped(response, 3, () => new Error("too large"))).rejects.toThrow(
      "too large",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
