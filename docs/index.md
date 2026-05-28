# Octopool

Octopool is a self-hosted GitHub read relay and shared cache. One Cloudflare Worker holds
your org's PATs and GitHub App installations, picks the healthiest one per request, and
caches the response in D1 so the next caller doesn't burn any GitHub rate budget.

The pitch in one paragraph: a maintainer team plus a few bots make the same handful of
read calls (`gh pr view`, `gh pr checks`, `gh run list`, `gh issue list`, `gh api repos/...`)
against the same repos all day. Each developer's PAT and each App installation has its own
quota; they're not shared and they overlap heavily. Octopool pools the identities behind
one Cloudflare Worker, serves a normalized read-only API, and adds a read-through D1
cache so repeated reads return without touching GitHub at all. Tokens stay server-side,
membership is org-gated, and the CLI falls through to your real `gh` for anything outside
the supported read shapes.

## Get started

- New to it? Read the [project overview in the README](https://github.com/openclaw/octopool#readme).
- Want to deploy octopool for your own org on Cloudflare? See
  [Deployment & operations](operations.md) — Cloudflare resources, secrets, migrations,
  custom domains, and the smoke test.
- Already on someone else's deployment? Install the [CLI](cli.md) and run
  `octopool login <server>`.

## Feature docs

- [GitHub read relay](relay.md) — the `POST /v1/github/request` endpoint, supported
  routes, response envelope, policy gates, and safety limits.
- [Octopool CLI](cli.md) — `octopool login [server]`, discovery, `whoami`, the `gh` shim,
  and real-`gh` fallback.
- [Pooled identities & routing](identities.md) — PAT and GitHub App identities, scopes,
  and the pool coordinator's selection, leases, and cooldowns.
- [Cache & public-repo guard](cache.md) — the D1 read-through cache and public-only
  visibility enforcement.
- [Auth & org membership](auth.md) — caller auth, admin auth, website sessions, and the
  GitHub-CLI login exchange.
- [Admin & provisioning](admin.md) — registering callers and identities.
- [Landing page & GitHub login](landing.md) — `octopool.openclaw.ai`, `octopool.dev`,
  and the OAuth entry.
- [Dashboard](dashboard.md) — GitHub-login-gated limits, cache, identity, and caller usage
  views.
- [Deployment & operations](operations.md) — Cloudflare resources, config, migrations,
  build/test/deploy.

## Reference

- [Project spec](spec.md) — the full product contract and design.
