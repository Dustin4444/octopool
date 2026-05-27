# Octopool Spec

## Product Contract

`octopool` is a Cloudflare-hosted GitHub request relay for `gitcrawl`.

It lets trusted users and agents share an explicitly managed pool of GitHub identities for read-heavy maintainer automation, while keeping credentials off developer machines and enforcing routing, audit, and safety policy centrally.

## Goals

- route `gitcrawl gh` cache misses and live reads through a shared relay
- support 1..n GitHub identities per pool
- prefer healthy identities with available rate budget
- avoid agent stampedes against the same GitHub endpoint
- keep GitHub tokens out of logs, local config, and SQLite stores
- expose compact quota, health, and audit state for maintainers
- preserve local `gitcrawl` behavior when the relay is unavailable

## Non-Goals

- general-purpose HTTP proxy
- storing or relaying private repository responses in the shared cache
- bypassing GitHub authorization, repository permissions, or abuse controls
- mutating GitHub state by default
- replacing `gitcrawl` local SQLite search/cache
- public multi-tenant SaaS

## Trust Model

Pools are private, explicit, and admin-managed.

Allowed identities:

- user-provided GitHub PATs with informed consent
- GitHub App installations where public repo access is intended
- service accounts only where GitHub policy and org policy allow them

Disallowed behavior:

- token scraping
- hidden credential reuse
- rotating identities to evade repo/user bans or abuse detection
- cross-user private repo access without explicit authorization

Shared cache v1 is public-repository-only. Octopool checks repository visibility through GitHub's public repository endpoint before selecting a pooled identity or reading/writing D1 cache entries for repo routes.

## Architecture

- `worker`: public HTTPS API, auth, request validation, response shaping
- `PoolCoordinator` Durable Object: per-pool routing, leases, health, rate snapshots
- D1: users, pools, credential metadata, audit summaries, policy config
- Cloudflare Secrets / Secrets Store: GitHub tokens and app private keys
- Analytics Engine or logs: aggregate metrics, no secrets, redacted request bodies
- `gitcrawl` client: local shim integration, fallback behavior, cache tagging

Durable Object partition key:

```text
pool:<pool_id>
```

Optional future sharding:

```text
pool:<pool_id>:route:<owner>
pool:<pool_id>:route:<owner>/<repo>
```

## Request Flow

1. `gitcrawl gh ...` handles local/cacheable reads first.
2. On configured cache miss, gitcrawl sends a normalized relay request to Octopool.
3. Worker authenticates caller and validates command policy.
4. Worker forwards routing request to the pool Durable Object.
5. Worker verifies repo routes are public before cache or pooled identity use.
6. Durable Object selects a GitHub identity and creates a short lease.
7. Worker performs the GitHub API request with the selected credential.
8. GitHub App identities mint short-lived installation tokens server-side.
9. Worker records rate-limit headers, status, route class, and redacted audit state.
10. Worker returns a normalized response to gitcrawl.
11. gitcrawl stores the response in its existing cache when eligible.

## API

Base:

```text
https://octopool.<domain>/
```

### `POST /v1/github/request`

Primary relay endpoint.

Request:

```json
{
  "pool": "maintainers",
  "method": "GET",
  "path": "/repos/openclaw/openclaw/pulls/123",
  "query": {
    "per_page": "100"
  },
  "headers": {
    "accept": "application/vnd.github+json"
  },
  "route_hint": {
    "owner": "openclaw",
    "repo": "openclaw",
    "kind": "pr_view"
  },
  "cache_key": "gitcrawl-gh:...",
  "idempotency_key": "..."
}
```

Response:

```json
{
  "status": 200,
  "headers": {
    "content-type": "application/json",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4998",
    "x-ratelimit-reset": "1780000000"
  },
  "body": {},
  "identity": {
    "id": "ghu_...",
    "kind": "pat",
    "login": "redacted-or-public-login"
  },
  "relay": {
    "pool": "maintainers",
    "request_id": "...",
    "cacheable": true,
    "stale_ok": false
  }
}
```

Notes:

- v1 supports GitHub REST first.
- GraphQL is a separate endpoint because cost accounting differs.
- Mutations are rejected unless explicitly enabled per pool and route.
- Request bodies are rejected for read-only routes.

### `POST /v1/github/graphql`

Future endpoint for GraphQL.

Required before enabling:

- query fingerprinting
- cost extraction
- per-identity cost budget
- persisted query allowlist for high-volume agent paths

### `GET /v1/pools/:pool/health`

Returns redacted pool health.

Fields:

- identities_total
- identities_healthy
- remaining_by_resource
- reset_windows
- recent_errors
- policy_version

### `POST /v1/admin/pools/:pool/identities`

Admin-only identity registration.

v1 should store secret material through Wrangler/Cloudflare secret tooling, then store only metadata and secret references in D1.

GitHub App identity body:

```json
{
  "id": "ghapp_openclaw_openclaw",
  "kind": "github_app",
  "login": "octopool-cache",
  "secret_ref": "OCTOPOOL_GITHUB_APP_PRIVATE_KEY",
  "installation_id": 135990630,
  "scopes": [{ "owner": "openclaw", "repo": "openclaw" }]
}
```

The App ID is configured as `OCTOPOOL_GITHUB_APP_ID`; the private key secret must be stored as PKCS#8 `BEGIN PRIVATE KEY` PEM so Cloudflare Workers WebCrypto can sign GitHub App JWTs.

## Routing Policy

Inputs:

- route kind
- owner/repo
- GitHub resource bucket from previous responses
- identity repo permissions
- remaining budget
- reset time
- recent error score
- caller identity
- pool policy

Default strategy:

- prefer identity with highest usable remaining budget for the target resource
- avoid identities with recent 401, 403, abuse, or secondary-rate-limit responses
- keep short per-route leases to avoid many agents piling onto the same identity
- respect repo allowlists and deny private repo routes without an explicit grant
- serve stale cached gitcrawl data locally before relay when policy allows it

Lease shape:

```text
route_key: GET /repos/:owner/:repo/pulls/:number
identity_id: ghu_...
ttl: 5s..30s
reason: highest_remaining|sticky|cooldown_skip|fallback
```

## Data Model

D1 tables:

- `pools`: pool id, name, policy json, created_at, updated_at
- `callers`: relay clients, public key hash or token hash, status
- `caller_pools`: caller to pool grants
- `identities`: id, pool id, kind, login, secret ref, status, weight
- `identity_scopes`: owner, repo, permission hints, allow_private
- `rate_snapshots`: identity id, resource, limit, remaining, reset_at, source
- `route_errors`: route key, identity id, status, reason, expires_at
- `audit_events`: request id, caller id, pool id, route key, identity id, status, timestamps

Secret values:

- not in D1
- not in KV
- not in request logs
- only referenced by stable secret name or encrypted handle

## Auth

Caller auth:

- `Authorization: Bearer <octopool_client_token>` for v1
- tokens stored as hashes in D1
- optional mTLS or signed request headers later

Admin auth:

- separate admin token or Cloudflare Access
- no admin endpoints exposed to ordinary gitcrawl clients

GitHub auth:

- PATs: stored as Cloudflare secrets
- GitHub Apps: private key as secret; installation tokens minted and cached by identity

## Security Rules

- redact `authorization`, `cookie`, `set-cookie`, token-like query params, and request bodies by default
- deny unknown hosts; only `api.github.com` in v1
- deny redirects to non-GitHub hosts
- cap response size
- cap request timeout
- reject mutation verbs unless route is explicitly allowed
- audit every routed request with route key and identity id
- expose public login only if policy allows it; otherwise use identity id

## gitcrawl Integration

Config:

```toml
[relay]
enabled = true
url = "https://octopool.example.com"
pool = "maintainers"
token_env = "OCTOPOOL_TOKEN"
mode = "cache-miss"
```

Environment:

```text
OCTOPOOL_URL
OCTOPOOL_TOKEN
OCTOPOOL_POOL
GITCRAWL_RELAY_URL
GITCRAWL_RELAY_TOKEN
```

Modes:

- `off`: never use relay
- `cache-miss`: local cache/search first, relay for supported misses
- `live-read`: relay preferred for supported read-only GitHub requests
- `direct`: bypass relay and use local `gh`/GitHub credentials

Fallback:

- relay unavailable: fall back to existing `gitcrawl gh` behavior
- relay 429/403 with stale local cache: serve stale when command policy allows
- relay policy deny: fail closed and explain route/policy, not token identity

## Supported v1 Routes

Read-only REST:

- issue view/list/search
- PR view/list/checks/status/files
- run list/view
- workflow list/view
- release list/view
- repo view/list
- labels
- GET-only `gh api`

Deferred:

- logs with large payloads
- GraphQL
- search endpoints with special quota behavior
- mutations

## Observability

Metrics:

- requests by caller, pool, route kind, status
- GitHub rate remaining by identity/resource
- relay cache hit/miss once response cache exists
- denied routes by policy reason
- secondary-rate-limit events
- fallback count reported by gitcrawl clients

Debug commands later:

```text
octopool pools
octopool health maintainers
octopool identities maintainers
octopool audit --since 1h
```

## Deployment

Cloudflare resources:

- Worker: `octopool`
- Durable Object: `PoolCoordinator`
- D1 database: `octopool`
- Secrets: `OCTOPOOL_ADMIN_TOKEN`, GitHub identity secrets

Repo layout:

```text
docs/spec.md
src/index.ts
src/pool-coordinator.ts
src/github.ts
src/policy.ts
src/schema.sql
test/
wrangler.jsonc
```

## Open Questions

- PAT-only v1 or GitHub App first?
- Should Octopool cache responses, or only coordinate token selection?
- Do we need Cloudflare Access from day one for admin endpoints?
- Which `gitcrawl gh` commands should be relay-enabled first?
- Should private repos require per-repo grants even inside a trusted pool?
