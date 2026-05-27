# Landing Page & GitHub Login

`octopool.dev` serves a deliberately minimal landing page — an animated angry octopus, a
"Sign in with GitHub" button, a dashboard link, and a docs link — while API clients can
still request JSON.

Source: `src/landing.ts`, `src/index.ts` (`/`, `githubLoginRedirect`).

## Content negotiation at `/`

`GET /` branches on the `Accept` header:

- default or `Accept: text/html` → the landing page (`text/html`, `cache-control: public, max-age=300`).
- explicit `Accept: application/json` without `text/html` → the JSON health response with `cache-control: no-store`.

This keeps the public page friendly for browser and chat-link clients while preserving a
root health response for explicit JSON probes. The page intentionally says nothing about
what Octopool is, and is marked `noindex`.

The page is a single self-contained HTML string: an inline SVG octopus with CSS
animations (bobbing, swaying tentacles, an anger glow), pointer-tracking eyes/tilt, and a
click-to-rage shake. It respects `prefers-reduced-motion`. App icon artwork lives in
`docs/assets/`.

## `GET /login/github`

The sign-in button links here. The Worker creates a short-lived OAuth state, stores only a
hash in D1, sets an `HttpOnly` state cookie, and issues a 302 redirect:

- If `GITHUB_OAUTH_CLIENT_ID` is configured, it redirects to GitHub's OAuth authorize URL
  with `scope=read:org`, `allow_signup=false`, and
  `redirect_uri=<origin>/login/github/callback`.
- If no client id is configured, it falls back to `https://github.com/login`.

The `read:org` scope and `allow_signup=false` reflect that Octopool access is gated on
OpenClaw org membership (see [Auth](auth.md)).

## `GET /login/github/callback`

The callback exchanges the GitHub OAuth code, verifies the GitHub user, checks OpenClaw
membership through the configured org verifier token, finds the already-provisioned
caller by immutable GitHub user id, and creates a web session. The dashboard additionally
requires `dashboard_role = 'admin'`. Browser-facing login and dashboard failures render a
small HTML error page instead of exposing the API JSON envelope.
