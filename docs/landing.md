# Landing Page & GitHub Login

`octopool.dev` serves a deliberately minimal landing page — an animated angry octopus, a
"Sign in with GitHub" button, and a docs link — while API clients keep getting JSON.

Source: `src/landing.ts`, `src/index.ts` (`/`, `githubLoginRedirect`).

## Content negotiation at `/`

`GET /` branches on the `Accept` header:

- `Accept: text/html` → the landing page (`text/html`, `cache-control: public, max-age=300`).
- anything else → the JSON health response with `cache-control: no-store`.

This keeps the relay's health probe and the public page on the same root path. The page
intentionally says nothing about what Octopool is, and is marked `noindex`.

The page is a single self-contained HTML string: an inline SVG octopus with CSS
animations (bobbing, swaying tentacles, an anger glow), pointer-tracking eyes/tilt, and a
click-to-rage shake. It respects `prefers-reduced-motion`. App icon artwork lives in
`docs/assets/`.

## `GET /login/github`

The sign-in button links here. The Worker issues a 302 redirect:

- If `GITHUB_OAUTH_CLIENT_ID` is configured, it redirects to GitHub's OAuth authorize URL
  with `scope=read:org`, `allow_signup=false`, and
  `redirect_uri=<origin>/login/github/callback`.
- If no client id is configured, it falls back to `https://github.com/login`.

The `read:org` scope and `allow_signup=false` reflect that Octopool access is gated on
OpenClaw org membership (see [Auth](auth.md)). The callback handler is not implemented in
v1 — the CLI login flow (`octopool login`, via `gh auth token`) is the working
authentication path; the web button is a placeholder OAuth entry.
