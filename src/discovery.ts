import { envSecret } from "./auth";
import { APP_ORIGIN, PUBLIC_HOST, effectiveHost, effectiveOrigin } from "./hosts";
import { jsonResponse } from "./http";

const DISCOVERY_VERSION = 1;
const MIN_CLI_VERSION = "0.2.2";

export function discoveryResponse(request: Request, env: Env): Response {
  const host = effectiveHost(request, env);
  const origin = effectiveOrigin(request, env);
  const apiBase = origin;
  const appBase = host === PUBLIC_HOST ? APP_ORIGIN : origin;
  return jsonResponse(
    {
      service: "octopool",
      version: DISCOVERY_VERSION,
      api_base: apiBase,
      app_base: appBase,
      default_pool: loginPool(env),
      allowed_org: env.ALLOWED_GITHUB_ORG,
      auth: {
        cli_github_token: true,
        web_login: true,
      },
      min_cli_version: MIN_CLI_VERSION,
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

function loginPool(env: Env): string {
  const configured = envSecret(env, "DEFAULT_LOGIN_POOL");
  return configured === undefined || configured.trim() === "" ? "maintainers" : configured.trim();
}
