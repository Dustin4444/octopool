# Landing Page & GitHub Login

Octopool has two browser hosts on the same backing Worker and data plane:

- `octopool.openclaw.ai` is the authoritative website. It serves the animated angry
  octopus, GitHub sign-in, dashboard link, and docs link. This host is served by a thin
  OpenClaw-account proxy Worker that forwards into the backing `octopool.dev` Worker.
- `octopool.dev` is the mysterious public/download face. It serves the same angry
  octopus, but the primary action is `brew install openclaw/tap/octopool`; web login and
  dashboard paths redirect to `octopool.openclaw.ai`.

API clients can still request JSON from either host.

Source: `src/landing.ts`, `src/web-routing.ts`, `src/web-session.ts`, `src/router.ts`,
`src/openclaw-proxy.ts`.

## Content negotiation at `/`

`GET /` branches on the `Accept` header:

- default or `Accept: text/html` → the landing page (`text/html`, `cache-control: public, max-age=300`).
- explicit `Accept: application/json` without `text/html` → the JSON health response with `cache-control: no-store`.

This keeps the browser pages friendly for chat-link clients while preserving a root health
response for explicit JSON probes. The public `octopool.dev` page intentionally says
almost nothing about what Octopool is, and both pages are marked `noindex`.

The page is a single self-contained HTML string: an inline SVG octopus with CSS
animations (bobbing, swaying tentacles, an anger glow), pointer-tracking eyes/tilt, and a
click-to-rage shake. The public install command includes a dedicated copy button. It
respects `prefers-reduced-motion`. App icon artwork lives in `docs/assets/`.

## `GET /login/github`

The authoritative website's sign-in button links here. The Worker creates a short-lived
signed OAuth state, mirrors it in an `HttpOnly` state cookie, and issues a 302 redirect:

- If `GITHUB_OAUTH_CLIENT_ID` is configured, it redirects to GitHub's OAuth authorize URL
  with `scope=read:org`, `allow_signup=false`, and
  `redirect_uri=<callback-origin>/login/github/callback`. The callback origin defaults
  to the effective request origin, or `GITHUB_OAUTH_CALLBACK_ORIGIN` when the GitHub App
  is registered to a different host.
- If no client id is configured, it falls back to `https://github.com/login`.

The `read:org` scope and `allow_signup=false` reflect that Octopool access is gated on
OpenClaw org membership (see [Auth](auth.md)).

On `octopool.dev`, `/login/github` and `/dashboard` redirect to
`https://octopool.openclaw.ai/...`; `/login/github/callback` preserves GitHub's `code`
and `state` query while forwarding back to the authoritative host. `/logout` stays local
long enough to clear any old host-scoped cookie, then returns to the public page. `octopool.dev` does not issue new
website sessions, and dashboard JSON endpoints are not served there.

## `GET /login/github/callback`

The callback exchanges the GitHub OAuth code, verifies the GitHub user, checks OpenClaw
membership through the configured org verifier token, creates or refreshes the caller
grant by immutable GitHub user id, and creates a web session. The dashboard additionally
requires `dashboard_role = 'admin'`. Browser-facing login and dashboard failures render a
small HTML error page instead of exposing the API JSON envelope.
