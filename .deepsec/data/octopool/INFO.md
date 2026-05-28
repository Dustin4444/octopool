# octopool

## What this codebase does

Octopool is a Cloudflare Worker + Durable Object + D1 service with a Go CLI. It is an org-gated, public-repository-only GitHub REST read relay/cache: trusted OpenClaw callers send normalized read requests, the Worker checks auth/policy/public visibility, serves D1 cache hits, or calls GitHub with a server-side PAT/App identity. The main trust boundary is between untrusted callers/browser users and pooled GitHub credentials/cache contents.

## Auth shape

- `authenticateCaller` validates bearer caller tokens by SHA-256 hash, caller status, pool grant, allowed org, and stale org-membership refresh.
- `authenticateAdmin` protects `/v1/admin/...` with `OCTOPOOL_ADMIN_TOKEN` and constant-time comparison.
- `requireDashboardAdmin` / `authenticateWebSession` protect `/dashboard`, `/v1/me`, and `/v1/dashboard` using hashed `octopool_session` cookies plus `dashboard_role = 'admin'`.
- `loginGitHubCLI` and `finishGitHubWebLogin` mint local caller/session tokens only for pre-provisioned GitHub user ids in `ALLOWED_GITHUB_ORG`.
- CLI auth helpers `validateLoginURL` and `validateAuthURLForRequest` prevent saved Octopool tokens from being sent to arbitrary HTTP or overridden URLs.

## Threat model

Highest impact: using Octopool to access private GitHub data or to exfiltrate/burn pooled GitHub tokens. Next: poisoning or reading shared cache entries across pools/repos, bypassing org/dashboard gates, or forcing the Worker to call arbitrary GitHub/redirect targets. Lower but relevant: leaking caller/admin/session tokens through logs, D1, query params, fallback `gh`, or generated dashboard responses.

## Project-specific patterns to flag

- Any relay route added to `src/policy.ts` must remain read-only, owner-allowlisted, and compatible with the public-repo guard before pooled identity/cache use.
- Any GitHub fetch in `src/github.ts`, `src/auth.ts`, or `src/public-repos.ts` must stay pinned to `https://api.github.com` or `https://github.com`; redirects are manually constrained for log downloads.
- Any cache read/write path must include pool, route key/kind, public-repo proof, and safe vary headers; private or token-specific data must not enter `github_cache_entries`.
- Any browser route exposing pool-wide stats/identities/callers must go through `requireDashboardAdmin`, not caller bearer auth alone.
- Any CLI fallback/shim path must fall back to real `gh` for mutations, unsafe headers/query keys, unsupported flags, or URL/auth overrides.

## Known false-positives

- `src/landing.ts` serves a public landing page at `/`; it is intentionally unauthenticated and marked `noindex`.
- `GET /` with `Accept: application/json` returns public health JSON without auth; authenticated health is `/v1/pools/:pool/health`.
- `src/github.ts` follows redirects only for GitHub Actions log URLs and explicitly requires HTTPS plus GitHub Actions/blob host suffixes.
- `src/generated/sql.ts` and `internal/dbquery/` are generated from `sql/queries/*.sql`; fix query source, then regenerate.
- `.deepsec/data/`, `.wrangler/`, `dist/`, and `node_modules/` are generated/local state and should not be treated as product code.
