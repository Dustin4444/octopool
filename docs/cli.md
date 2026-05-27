# Octopool CLI

The `octopool` Go CLI is the product entrypoint. It logs in against the relay, stores a
caller token locally, and acts as a drop-in `gh` shim for the read-only GitHub commands
Octopool supports — falling through to the real `gh` for everything else.

Source: `cmd/octopool/`.

The compiled-in default endpoint is `https://octopool.dev`. No config is required for
normal use.

## Install modes

Install with Homebrew:

```sh
brew install openclaw/tap/octopool
```

Or install from source:

```sh
go install github.com/openclaw/octopool/cmd/octopool@latest
```

The binary inspects `argv[0]` and behaves as a `gh` shim when invoked as `gh` or
`octopool-gh`:

- `octopool gh ...` — explicit subcommand.
- symlink `octopool` as `gh` — transparent shim on `PATH`.
- symlink `octopool` as `octopool-gh` — side-by-side shim.

## Commands

### `octopool login`

Reads a local GitHub token (`GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`), exchanges it
with `POST /v1/login/github-cli`, and saves the returned caller token.

- The login URL must be HTTPS. `http://` is allowed only for loopback hosts, or when
  `OCTOPOOL_ALLOW_INSECURE_LOGIN=1` is set for local development.
- The token is stored 0600 at `<user-config-dir>/octopool/auth.json` (URL, pool, token,
  login, timestamp).
- Octopool validates the GitHub identity and OpenClaw org membership during login, and
  binds the caller by immutable GitHub user id. See [Auth](auth.md).

```sh
octopool login
# logged in to https://octopool.dev as steipete for pool maintainers
```

### `octopool gh api <GET path> [--jq <expr>]`

Relays a read-only `gh api` call through Octopool's cache and pool. Prints the GitHub
response body exactly like `gh api`, optionally piping it through `jq -r <expr>`.

```sh
octopool gh api repos/openclaw/openclaw/pulls/85341 --jq .number
# 85341
```

The command falls through to the real `gh` (no relay call) when any of these hold:

- method is not `GET`, or mutating field flags are present (`-f`, `-F`, `--field`,
  `--raw-field`, `--paginate`, `--slurp`).
- the path is not a relay-supported shape (see [Relay](relay.md#supported-routes)).
- the repo owner is outside the local allowlist (`OCTOPOOL_ALLOWED_OWNERS`, default
  `openclaw`). Ordinary non-OpenClaw reads stay on the real `gh`.
- a query key looks secret-bearing, or a header is outside the safe set
  (`accept`, `x-github-api-version`, `if-none-match`, `if-modified-since`).
- `--jq` was requested but `jq` is not installed.

Any other `gh` subcommand (`gh pr create`, `gh auth`, …) is passed straight through to
the real GitHub CLI, with its exit code preserved.

### `octopool health [--pool <id>]`

Fetches `GET /v1/pools/<pool>/health` using the stored token. Returns identity counts and
policy version.

### `octopool request --path <p> [--method GET] [--query k=v] [--header k=v]`

Debug/admin raw wrapper over `POST /v1/github/request`. Prints the full relay envelope.

### `octopool admin caller|identity ...`

Admin provisioning. Requires an admin token. See [Admin & provisioning](admin.md).

## Token and URL safety

- A saved caller token is only sent to the saved Octopool URL. Overriding `--url` (or
  `OCTOPOOL_URL`) to a different host requires an explicit `OCTOPOOL_TOKEN`, or a fresh
  `octopool login` for that URL. This prevents leaking the token to an attacker-supplied
  endpoint.
- Once a request reaches Octopool, relay policy denials fail closed; they are not
  silently retried against the real `gh`.

## Environment variables

These are dev/CI escape hatches, not the everyday UX:

- `OCTOPOOL_URL` — base URL override.
- `OCTOPOOL_TOKEN` — caller token override (required to use a non-saved URL).
- `OCTOPOOL_POOL` — pool id (default `maintainers`).
- `OCTOPOOL_GH_PATH` — path to the real `gh` binary.
- `OCTOPOOL_ALLOWED_OWNERS` — local owner prefilter for the `gh` shim (default `openclaw`).
- `OCTOPOOL_ADMIN_TOKEN` — admin token for `octopool admin`.
- `OCTOPOOL_ALLOW_INSECURE_LOGIN=1` — permit non-HTTPS login for local dev.
