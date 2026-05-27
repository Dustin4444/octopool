#!/bin/sh
set -eu

host="${OCTOPOOL_E2E_HOST:-octopool.dev}"
resolver="${OCTOPOOL_E2E_RESOLVER:-1.1.1.1}"
ip="$(dig +short "$host" A @"$resolver" | head -n 1)"

if [ -z "$ip" ]; then
  echo "no A record for $host via $resolver" >&2
  exit 1
fi

root="$(curl --resolve "$host:443:$ip" -fsS "https://$host/")"
printf "%s" "$root" | grep -q '"ok":true'
printf "%s" "$root" | grep -q '"service":"octopool"'

health_code="$(
  curl --resolve "$host:443:$ip" -sS -o /tmp/octopool-health.json -w "%{http_code}" \
    "https://$host/v1/pools/maintainers/health"
)"
test "$health_code" = "401"
grep -q '"code":"missing_auth"' /tmp/octopool-health.json

relay_code="$(
  curl --resolve "$host:443:$ip" -sS -o /tmp/octopool-relay.json -w "%{http_code}" \
    -H "content-type: application/json" \
    -d '{"pool":"maintainers","method":"GET","path":"/repos/openclaw/openclaw/pulls/1"}' \
    "https://$host/v1/github/request"
)"
test "$relay_code" = "401"
grep -q '"code":"missing_auth"' /tmp/octopool-relay.json

echo "octopool e2e ok: $host via $ip"
