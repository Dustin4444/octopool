import { HttpError, parsePositiveInt } from "./http";
import { responseCapBytes } from "./github";
import type { GitHubRelayResponse, RelayRequest, RouteInfo } from "./types";

const MEDIA_DIFF = new Set([
  "application/vnd.github.diff",
  "application/vnd.github.v3.diff",
  "application/vnd.github.v3+diff",
]);
const MEDIA_PATCH = new Set([
  "application/vnd.github.patch",
  "application/vnd.github.v3.patch",
  "application/vnd.github.v3+patch",
]);

export async function callGitHubWeb(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): Promise<GitHubRelayResponse | undefined> {
  const web = webRequest(env, request, route);
  if (web === undefined) {
    return undefined;
  }
  let response: Response;
  try {
    response = await fetch(web.url, {
      method: "GET",
      headers: web.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000)),
    });
  } catch {
    return undefined;
  }
  if (response.status < 200 || response.status >= 300) {
    return undefined;
  }
  try {
    const body = await readBodyCapped(response, web.capBytes);
    return web.payload(new Uint8Array(body), response.headers);
  } catch {
    return undefined;
  }
}

function webRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
):
  | {
      url: string;
      headers: Record<string, string>;
      capBytes: number;
      payload: (body: Uint8Array, headers: Headers) => GitHubRelayResponse;
    }
  | undefined {
  if (request.method !== "GET" || route.owner === undefined || route.repo === undefined) {
    return undefined;
  }
  const media = mediaFormat(request.headers?.accept);
  if (media !== undefined) {
    const mediaURL = mediaWebURL(request, route, media);
    if (mediaURL === undefined) {
      return undefined;
    }
    const contentType = media === "patch" ? "text/x-patch" : "text/x-diff";
    return {
      url: mediaURL,
      headers: { accept: `${contentType}, text/plain, */*`, "user-agent": "octopool" },
      capBytes: responseCapBytes(env, route),
      payload: (body, headers) => ({
        status: 200,
        headers: webHeaders(headers, contentType),
        body: new TextDecoder().decode(body),
        body_encoding: "text",
        backend: "web",
      }),
    };
  }
  if (route.kind !== "contents" || !defaultJSONAccept(request.headers?.accept)) {
    return undefined;
  }
  const ref = stringQuery(request.query, "ref");
  if (ref === undefined || !safeGitRefPath(ref)) {
    return undefined;
  }
  const contentPath = contentPathFromRequest(request, route);
  if (contentPath === undefined || !safeRelativePath(contentPath)) {
    return undefined;
  }
  const rawURL = `https://raw.githubusercontent.com/${pathSegments([route.owner, route.repo, ref, contentPath])}`;
  return {
    url: rawURL,
    headers: { accept: "text/plain, */*", "user-agent": "octopool" },
    capBytes: responseCapBytes(env, route),
    payload: (body, headers) => {
      const sha = gitBlobSHA(body);
      const apiPath = `/repos/${route.owner}/${route.repo}/contents/${contentPath}`;
      const apiURL = `https://api.github.com${apiPath}?ref=${encodeURIComponent(ref)}`;
      const htmlURL = `https://github.com/${pathSegments([route.owner!, route.repo!, "blob", ref, contentPath])}`;
      return {
        status: 200,
        headers: webHeaders(headers, "application/json"),
        body: {
          type: "file",
          encoding: "base64",
          name: contentPath.split("/").at(-1) ?? contentPath,
          path: contentPath,
          sha,
          size: body.byteLength,
          content: bytesToBase64(body),
          url: apiURL,
          html_url: htmlURL,
          git_url: `https://api.github.com/repos/${route.owner}/${route.repo}/git/blobs/${sha}`,
          download_url: rawURL,
          _links: {
            self: apiURL,
            git: `https://api.github.com/repos/${route.owner}/${route.repo}/git/blobs/${sha}`,
            html: htmlURL,
          },
        },
        body_encoding: "json",
        backend: "web",
      };
    },
  };
}

function mediaWebURL(
  request: RelayRequest,
  route: RouteInfo,
  media: "diff" | "patch",
): string | undefined {
  switch (route.kind) {
    case "pr_view": {
      const number = /\/pulls\/([0-9]+)$/.exec(request.path)?.[1];
      if (number === undefined) {
        return undefined;
      }
      return `https://github.com/${pathSegments([route.owner!, route.repo!, "pull", number])}.${media}`;
    }
    case "commit_view": {
      const sha = /\/commits\/([0-9A-Fa-f]{7,64})$/.exec(request.path)?.[1];
      if (sha === undefined) {
        return undefined;
      }
      return `https://github.com/${pathSegments([route.owner!, route.repo!, "commit", sha])}.${media}`;
    }
    case "compare": {
      const ref = /\/compare\/([^/?#]+)$/.exec(request.path)?.[1];
      if (ref === undefined) {
        return undefined;
      }
      const decodedRef = decodePathComponent(ref);
      if (decodedRef === undefined) {
        return undefined;
      }
      return `https://github.com/${pathSegments([route.owner!, route.repo!, "compare"])}/${encodeURIComponent(decodedRef)}.${media}`;
    }
    default:
      return undefined;
  }
}

function mediaFormat(accept: string | undefined): "diff" | "patch" | undefined {
  const normalized = (accept ?? "").toLowerCase();
  const values = normalized.split(",").map((item) => item.trim().split(";")[0] ?? "");
  if (values.some((value) => MEDIA_PATCH.has(value))) {
    return "patch";
  }
  if (values.some((value) => MEDIA_DIFF.has(value))) {
    return "diff";
  }
  return undefined;
}

function contentPathFromRequest(request: RelayRequest, route: RouteInfo): string | undefined {
  const prefix = `/repos/${route.owner}/${route.repo}/contents/`;
  if (!request.path.startsWith(prefix)) {
    return undefined;
  }
  const value = request.path.slice(prefix.length);
  if (value === "") {
    return undefined;
  }
  return decodePathComponent(value);
}

function decodePathComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function defaultJSONAccept(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") {
    return true;
  }
  const normalized = value.toLowerCase();
  return (
    normalized === "application/vnd.github+json" ||
    normalized === "application/json" ||
    normalized === "application/vnd.github.v3+json"
  );
}

function safeGitRefPath(value: string): boolean {
  return (
    value.length <= 200 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function safeRelativePath(value: string): boolean {
  return (
    value.length <= 1024 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function stringQuery(
  query: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined {
  const value = query?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function webHeaders(headers: Headers, contentType: string): Record<string, string> {
  const out: Record<string, string> = { "content-type": contentType };
  for (const key of ["etag", "last-modified", "cache-control"]) {
    const value = headers.get(key);
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

async function readBodyCapped(response: Response, capBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > capBytes) {
        await reader.cancel();
        throw new HttpError(
          502,
          "github_web_response_too_large",
          "GitHub web response is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function pathSegments(segments: string[]): string {
  return segments
    .flatMap((segment) => segment.split("/"))
    .map(encodeURIComponent)
    .join("/");
}

function gitBlobSHA(body: Uint8Array): string {
  // WebCrypto SHA-1 is unavailable in some Workers runtimes, so keep this tiny implementation local.
  return sha1(new Uint8Array([...new TextEncoder().encode(`blob ${body.byteLength}\0`), ...body]));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function sha1(message: Uint8Array): string {
  const words: number[] = [];
  for (let index = 0; index < message.length; index++) {
    words[index >> 2] = (words[index >> 2] ?? 0) | (message[index]! << (24 - (index % 4) * 8));
  }
  words[message.length >> 2] =
    (words[message.length >> 2] ?? 0) | (0x80 << (24 - (message.length % 4) * 8));
  words[(((message.length + 8) >> 6) << 4) + 15] = message.length * 8;
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  for (let offset = 0; offset < words.length; offset += 16) {
    const w = Array.from({ length: 80 }, (_, index) => words[offset + index] ?? 0);
    for (let index = 16; index < 80; index++) {
      w[index] = rotateLeft(w[index - 3]! ^ w[index - 8]! ^ w[index - 14]! ^ w[index - 16]!, 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index++) {
      const [f, k] =
        index < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : index < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : index < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const temp = (rotateLeft(a, 5) + f + e + k + w[index]!) | 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}
