# Gitcrawl gh Migration

## Goal

Move the `gh` shim/cache surface from gitcrawl to Octopool.

Gitcrawl remains the per-repo SQLite mirror, portable Git store, search, clustering, and triage product. Octopool becomes the org-authenticated `gh` cache, shared Cloudflare cache, and pooled GitHub read relay.

## Decisions

- Hard cut gitcrawl `gh`: it should print a migration error pointing users to Octopool.
- No user config required for normal use.
- `octopool login` is the entrypoint.
- Initial login uses the existing local `gh auth token`, exchanges it with Octopool, and stores an Octopool caller token locally.
- Octopool validates GitHub identity and OpenClaw org membership during login.
- CLI login binds provisioned callers by immutable GitHub user ID, not mutable login.
- Legacy production caller backfill is explicit in the D1 migration; no self-service mutable-login fallback.
- The default Octopool endpoint is compiled in as `https://octopool.dev`.
- Env vars remain dev/CI escape hatches, not the product UX.
- Octopool owns the shared Cloudflare cache for `gh` reads.
- Shared cache is public-repository-only. Repo routes must pass an unauthenticated GitHub public visibility check before pooled identity use or cache writes.
- OpenClaw GitHub App `octopool-cache` is installed only on selected repository `openclaw/openclaw` for v1; no private repo installation.
- No gitcrawl push/pull cache bridge. Regenerate shared cache through Octopool read-through misses.
- Gitcrawl portable stores keep their repo snapshot role and do not carry the runtime `gh` command cache.
- Mutating `gh` commands must pass through to the real GitHub CLI. Octopool does not add write-back behavior.
- Repo paths outside the local Octopool owner allowlist fall through to real `gh` before any relay call.

## Target Shape

```text
octopool login
gh api repos/openclaw/openclaw/pulls/85341
```

Install modes:

- `octopool gh ...`
- symlink `octopool` as `gh`
- symlink `octopool` as `octopool-gh`

Read path:

1. Octopool CLI parses a read-only `gh` shape.
2. CLI sends a normalized request to Octopool Worker.
3. Worker authenticates caller token.
4. Worker checks D1 cache.
5. Worker fetches GitHub through pooled identity on cache miss.
6. Worker writes D1 cache entry.
7. CLI unwraps the GitHub-shaped response and prints it like `gh api`.
8. Unsupported or mutating commands fall through to the real `gh`.

## Cloudflare Store

D1 tables:

- `github_cache_entries`
  - cache key
  - pool
  - method
  - path
  - query JSON
  - route kind/key
  - status
  - response headers JSON
  - body encoding
  - body JSON/text
  - source identity
  - created/expires timestamps

Durable Object:

- keep existing per-pool identity selection and rate coordination.
- cache stampede locks can be added later if D1 read-through contention becomes visible.

R2:

- deferred. Use D1 for v1 payloads because current supported routes are bounded.
- large Actions logs should either skip cache or move to R2 in a later migration.

## Octopool CLI

Commands:

- `octopool login`
  - reads local `gh auth token`
  - exchanges with `/v1/login/github-cli`
  - stores Octopool caller token in a local 0600 auth file
- `octopool gh api <GET path> [--jq <expr>]`
  - calls Octopool relay/cache
  - prints GitHub response body
- `octopool request`
  - remains debug/admin-facing raw relay wrapper
- `octopool health`
  - uses stored token by default

Env escapes:

- `OCTOPOOL_URL`
- `OCTOPOOL_TOKEN`
- `OCTOPOOL_POOL`
- `OCTOPOOL_GH_PATH`
- `OCTOPOOL_ALLOWED_OWNERS`

Security notes:

- Saved caller tokens are only sent to the saved Octopool URL. A URL override requires an explicit token env.
- Relay policy denials fail closed once a request reaches Octopool.
- Local owner prefiltering keeps ordinary non-OpenClaw `gh api` reads on the real GitHub CLI.
- GitHub App installation tokens are minted server-side from Cloudflare secrets and never stored locally.
- GitHub App private key is stored as PKCS#8 in Cloudflare and 1Password.
- Production pre-migration D1 had one caller row, `steipete`; migration `0002` backfills GitHub user ID `58493`.

## Gitcrawl Cut

`gitcrawl gh ...` should fail with:

```text
gitcrawl gh moved to octopool.
Run: octopool login
Then use: octopool gh ... or symlink octopool as gh.
```

The rest of gitcrawl remains intact.

## Progress

- [x] Plan and decision log.
- [x] Octopool Worker login exchange.
- [x] Octopool Worker D1 read-through cache.
- [x] Octopool CLI login/token store.
- [x] Octopool CLI `gh api` shim and real-gh fallback.
- [x] Gitcrawl hard-cut migration error.
- [x] Tests.
- [x] Autoreview.
- [x] Ship, deploy, e2e.

## Ship Proof

- Octopool commit: `1dd61b5`
- Gitcrawl commits: `a45f16c`, `b7bf40e`
- D1 migration `0002_github_cache.sql`: applied to remote `octopool`.
- Worker deploy: `octopool.dev`, version `e0ad3e22-5dfb-413c-bb14-af16249e7bd7`.
- E2E: `pnpm e2e`.
- CLI login: `go run ./cmd/octopool login`.
- CLI health: `go run ./cmd/octopool health`.
- CLI relay: `go run ./cmd/octopool gh api repos/openclaw/openclaw/pulls/85341 --jq .number` returned `85341`.
- Cache: raw request returned `miss`, repeated request returned `hit`; remote D1 cache row count `1`.
- Fallback: non-OpenClaw repo read fell through to real `gh` even with a bogus Octopool URL.
- Gitcrawl cut: `go run ./cmd/gitcrawl gh api ...` printed the Octopool migration note.
