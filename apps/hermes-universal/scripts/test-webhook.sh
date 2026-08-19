#!/usr/bin/env bash
# POST a signed test event at an Allr inbound webhook.
#
#   scripts/test-webhook.sh <route-or-url> [secret]
#
# The secret is the HMAC key shown once at create time (or WEBHOOK_SECRET).
# A route name posts to http://localhost:8644/webhooks/<name>. Override the
# port with WEBHOOK_PORT, the body with WEBHOOK_BODY.

set -euo pipefail

# ROUTE_OR_URL="${1:?usage: $0 <route-or-url> [secret]}"
# SECRET="${2:-${WEBHOOK_SECRET:?pass the signing secret as arg 2 or WEBHOOK_SECRET}}"

ROUTE_OR_URL="http://100.113.105.121:8644/webhooks/say-ello"
SECRET="3YOeUGwFEe57otpYzRHptSXWpXFvpfvxMizvmluCTa4"

if [[ "$ROUTE_OR_URL" == http://* || "$ROUTE_OR_URL" == https://* ]]; then
  URL="$ROUTE_OR_URL"
else
  URL="http://localhost:${WEBHOOK_PORT:-8644}/webhooks/${ROUTE_OR_URL}"
fi

BODY="${WEBHOOK_BODY:-{"test":false,"message":"hello from test-webhook.sh"}}"
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print "sha256="$2}')

curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIG" \
  -H "X-GitHub-Event: push" \
  -H "X-Request-ID: test-${RANDOM}-$(date +%s)" \
  -d "$BODY"
echo
