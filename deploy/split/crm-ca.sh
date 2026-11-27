#!/usr/bin/env bash
# Prints the root certificate of the CRM's internal Caddy authority, for the admin VM to trust
# (its deploy/crm-ca.crt; docs/deploy-split.md). Run on the CRM VM from deploy/azure after the split
# Caddyfile is up. A public certificate: safe to copy; it signs only the internal API's address.
set -euo pipefail
cd "$(dirname "$0")/../azure"
docker compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt
