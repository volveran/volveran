#!/usr/bin/env bash
# Regenerates the TLS material of the kind smoke test's mock OIDC provider:
# a private CA (ca.pem, which Volverán and the smoke test trust) and a server
# certificate for the provider's in-cluster names plus 127.0.0.1, as the
# PKCS12 keystore the provider reads (oidc.p12, password volveran-smoke).
# Test-only material, valid for 100 years, committed like test/fixtures/tls/.
# The keys are thrown away: to change anything, regenerate everything.
#
# Uses openssl from PATH, or from the pinned RabbitMQ test image when there is
# none (that image ships openssl).
set -euo pipefail
cd "$(dirname "$0")"

if command -v openssl >/dev/null; then
  ssl() { openssl "$@"; }
else
  # Rootless Docker maps the container's root to this user; rootful Docker needs -u.
  user=(-u "$(id -u):$(id -g)")
  if docker info -f '{{.SecurityOptions}}' | grep -q rootless; then user=(); fi
  ssl() { docker run --rm "${user[@]}" -v "$PWD:/work" -w /work --entrypoint openssl rabbitmq:4.4.0-management "$@"; }
fi

cat > oidc.ext <<'EXT'
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:oidc.volveran-smoke-deps.svc.cluster.local, DNS:oidc.volveran-smoke-deps.svc, DNS:localhost, IP:127.0.0.1
EXT

ssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj "/CN=Volveran smoke test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout ca.key -out ca.pem
ssl req -newkey rsa:2048 -nodes -subj "/CN=oidc.volveran-smoke-deps.svc.cluster.local" \
  -keyout oidc.key -out oidc.csr
ssl x509 -req -in oidc.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 36500 \
  -extfile oidc.ext -out oidc.pem
ssl pkcs12 -export -in oidc.pem -inkey oidc.key -name oidc -passout pass:volveran-smoke -out oidc.p12

rm -f ca.key ca.srl oidc.csr oidc.ext oidc.key oidc.pem
