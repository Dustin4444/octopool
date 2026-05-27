# Octopool

Octopool is a Cloudflare-hosted, org-authenticated GitHub read relay and shared cache for
`gitcrawl`. It lets trusted OpenClaw members and agents share a pool of GitHub identities
for read-heavy maintainer automation, keeping tokens off developer machines and enforcing
routing, caching, and safety policy centrally.

## Feature docs

- [GitHub read relay](relay.md) — the `POST /v1/github/request` endpoint, supported
  routes, response envelope, policy gates, and safety limits.
- [Octopool CLI](cli.md) — `octopool login`, the `gh` shim, and real-`gh` fallback.
- [Pooled identities & routing](identities.md) — PAT and GitHub App identities, scopes,
  and the pool coordinator's selection, leases, and cooldowns.
- [Cache & public-repo guard](cache.md) — the D1 read-through cache and public-only
  visibility enforcement.
- [Auth & org membership](auth.md) — caller auth, admin auth, and the GitHub-CLI login
  exchange.
- [Admin & provisioning](admin.md) — registering callers and identities.
- [Landing page & GitHub login](landing.md) — `octopool.dev` and the OAuth entry.
- [Deployment & operations](operations.md) — Cloudflare resources, config, migrations,
  build/test/deploy.

## Reference

- [Project spec](spec.md) — the full product contract and design.
- [Gitcrawl gh migration](gitcrawl-migrate.md) — moving the `gh` cache surface out of
  gitcrawl into Octopool.
