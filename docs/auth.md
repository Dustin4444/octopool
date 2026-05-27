# Auth & Org Membership

Octopool has three auth surfaces: caller auth for relay traffic, admin auth for
provisioning, and the GitHub-CLI login exchange that mints caller tokens. All of them are
pinned to a single allowed GitHub org (`ALLOWED_GITHUB_ORG`, `openclaw`).

Source: `src/auth.ts`, `src/index.ts` (`loginGitHubCLI`, `createCaller`).

## Caller auth

Relay and health requests send `Authorization: Bearer <octopool_caller_token>`.

- The token is hashed (SHA-256, base64url) and matched against `callers.token_hash`.
  Raw tokens are never stored.
- The caller must be `active` and granted the requested pool (`caller_pools`).
- The caller's `org_login` must equal `ALLOWED_GITHUB_ORG`, else `403 org_denied`.
- Org membership is re-verified on use once it goes stale (`ORG_VERIFY_TTL_SECONDS`,
  default 24h), using the org verifier token. A member who leaves the org loses access at
  the next check.

A missing/invalid token returns `401`; a valid token without the pool grant returns
`401 invalid_auth`.

## Admin auth

Admin endpoints (`/v1/admin/...`) require `Authorization: Bearer <OCTOPOOL_ADMIN_TOKEN>`.
The comparison is constant-time. If no admin token is configured, admin endpoints return
`503 admin_unconfigured`. Admin auth is entirely separate from caller auth — ordinary
callers can never reach admin routes.

## GitHub-CLI login exchange

`POST /v1/login/github-cli` turns a local GitHub token into an Octopool caller token.
This is what `octopool login` calls.

Flow:

1. Body carries `github_token` (the user's `gh auth token`) and an optional `pool`.
2. The Worker resolves the GitHub user (`GET /user`) and verifies that user is a member
   of `ALLOWED_GITHUB_ORG` using the supplied token.
3. The caller must already be **provisioned** — matched by immutable GitHub **user id**,
   org, active status, and a grant for the requested pool. There is no self-service
   pool grant: an unprovisioned user gets `403 caller_not_provisioned`.
4. A new caller token (`op_…`) is generated, hashed, and stored; the row is refreshed
   with the current login, user id, and verification time.
5. The plaintext token is returned once, for the CLI to store locally.

### Pool restriction

`octopool login` cannot self-grant an arbitrary pool. The requested pool must equal
`DEFAULT_LOGIN_POOL` (default `maintainers`); anything else is `403 pool_denied`. Binding
by user id (not the mutable login) is why production caller backfill is explicit in the
D1 migration rather than self-service.

## Org verification tokens

Two helpers check `GET /orgs/{org}/members/{login}`:

- During login, with the user's own token.
- During background freshness checks, with the configured `OCTOPOOL_GITHUB_ORG_TOKEN`.

`204` confirms membership; `404` denies (`403 org_member_denied`); anything else surfaces
as `502 org_verification_failed`. If the verifier token is unset, verification returns
`503 org_verification_unavailable`.
