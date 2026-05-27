# Changelog

## Unreleased

- Add GitHub App installation identities for public-repository relay reads, with Worker-minted installation tokens, selected-repo OpenClaw App setup, public-repo cache guards, and app avatar artwork.
- Move the GitHub CLI cache/shim surface out of gitcrawl into Octopool with `octopool login`, local token storage, `octopool gh api ...`, and a D1 read-through cache for pooled GitHub reads.
- Add a minimal octopool.dev landing page with an animated angry octopus and a GitHub sign-in button, served to browsers at `/` while API clients keep the JSON health response, plus a `/login/github` OAuth redirect.
- Add the initial Octopool Cloudflare relay, D1 schema, Durable Object pool coordinator, route policy tests, and strict Go CLI.
