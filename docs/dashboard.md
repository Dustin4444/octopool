# Dashboard

`/dashboard` is the browser view for Octopool operators.

Source: `src/dashboard.ts`, `src/index.ts` (`dashboardData`).

## Login model

The dashboard uses the admin token, because it exposes pool-wide identity state and other
callers' usage. Paste `OCTOPOOL_ADMIN_TOKEN`; the token is stored only in browser
localStorage and sent as `Authorization: Bearer …` to `/v1/dashboard`.

The endpoint uses the same admin auth boundary as provisioning. Ordinary relay caller
tokens cannot load dashboard data.

## Data shown

- caller and pool identity
- active/total pooled identities
- Durable Object rate-limit snapshots, active cooldowns, and live leases
- D1 cache totals, fresh/expired entries, body byte size, and route-kind breakdown
- public-repo proof count
- per-caller usage for the last seven days
- recent audit traffic with route kind, status, identity, and duration

Secrets, raw caller tokens, PAT values, and GitHub App private keys are never returned.
