# Deployment & Operations

Octopool is a single Cloudflare Worker plus a Durable Object and a D1 database, served on
the `octopool.dev` custom domain. The Go CLI is a separate binary.

Source: `wrangler.jsonc`, `migrations/`, `package.json`, `test/e2e.sh`.

## Cloudflare resources

- Worker `octopool` — entry `src/index.ts`, `nodejs_compat`, observability on.
- Durable Object `PoolCoordinator` (binding `POOL_COORDINATOR`, SQLite-backed,
  migration tag `v1`).
- D1 database `octopool` (binding `DB`).
- Custom domain route `octopool.dev`.

## Configuration

Plain vars (in `wrangler.jsonc`):

- `ALLOWED_GITHUB_ORG` = `openclaw`
- `DEFAULT_ALLOWED_OWNERS` = `openclaw`
- `MAX_RESPONSE_BYTES` = `2097152`
- `REQUEST_TIMEOUT_MS` = `15000`
- `ORG_VERIFY_TTL_SECONDS` = `86400`

Optional vars (set as needed): `PUBLIC_REPO_TTL_SECONDS` (default 30), `DEFAULT_LOGIN_POOL`
(default `maintainers`), `GITHUB_OAUTH_CLIENT_ID`.

Secrets (via `wrangler secret put`, never in D1/KV/logs):

- `OCTOPOOL_ADMIN_TOKEN` — admin auth.
- `OCTOPOOL_GITHUB_ORG_TOKEN` — background org-membership verifier.
- `OCTOPOOL_GITHUB_APP_ID` — GitHub App id (for App identities).
- One secret per identity `secret_ref` — PAT value, or the App private key as **PKCS#8**
  (`BEGIN PRIVATE KEY`) PEM. Keep a copy in 1Password.

## Migrations

D1 schema lives in `migrations/`:

- `0001_init.sql` — pools, callers, caller_pools, identities, identity_scopes,
  audit_events.
- `0002_github_cache.sql` — `github_user_id` column + production caller backfill, and
  `github_cache_entries`.
- `0003_github_app_public_cache.sql` — `installation_id` column and `github_public_repos`.

Apply with `wrangler d1 migrations apply octopool` (add `--remote` for production).

## Build, test, deploy

```sh
pnpm install
pnpm check     # format:check + lint + vitest + build + go test + go vet
pnpm test      # vitest only
pnpm deploy    # wrangler deploy
pnpm e2e       # smoke-test the live deployment
```

`pnpm check` is the full gate (TypeScript + Go). The Go CLI also builds/tests with
`go build ./cmd/octopool` and `go test ./...`.

## Smoke test

`test/e2e.sh` resolves `octopool.dev`, then asserts:

- `GET /` returns the JSON health body (`"ok":true`, `"service":"octopool"`).
- `GET /v1/pools/maintainers/health` without a token returns `401 missing_auth`.
- `POST /v1/github/request` without a token returns `401 missing_auth`.

Override the host/resolver with `OCTOPOOL_E2E_HOST` / `OCTOPOOL_E2E_RESOLVER`.

## Observability

Observability is enabled at full sampling. Every routed request writes an `audit_events`
row (caller, pool, route key/kind, identity, status, error code, duration); secrets and
request bodies are never recorded.
