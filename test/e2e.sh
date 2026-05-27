#!/bin/sh
set -eu

host="${OCTOPOOL_E2E_HOST:-octopool.dev}"
resolver="${OCTOPOOL_E2E_RESOLVER:-1.1.1.1}"
ip="$(dig +short "$host" A @"$resolver" | head -n 1)"

if [ -z "$ip" ]; then
  echo "no A record for $host via $resolver" >&2
  exit 1
fi

root_html="$(curl --resolve "$host:443:$ip" -fsS "https://$host/")"
printf "%s" "$root_html" | grep -q '<title>octopool</title>'

curl --resolve "$host:80:$ip" -sS -o /tmp/octopool-http.txt -D /tmp/octopool-http.headers \
  "http://$host/dashboard"
grep -q '^HTTP/1.1 308' /tmp/octopool-http.headers
grep -qi '^location: https://'"$host"'/dashboard' /tmp/octopool-http.headers

curl --resolve "$host:443:$ip" -sS -o /tmp/octopool-https.txt -D /tmp/octopool-https.headers \
  "https://$host/"
grep -qi '^strict-transport-security: max-age=31536000; includeSubDomains; preload' \
  /tmp/octopool-https.headers

root_json="$(curl --resolve "$host:443:$ip" -fsS -H "accept: application/json" "https://$host/")"
printf "%s" "$root_json" | grep -q '"ok":true'
printf "%s" "$root_json" | grep -q '"service":"octopool"'

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
