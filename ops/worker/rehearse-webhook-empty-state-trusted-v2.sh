#!/usr/bin/env bash
set -euo pipefail
# No published ports, host mounts, cloud credentials or production commands.
# The disposable runner shares only the isolated PostgreSQL network namespace.
suffix="$$-${RANDOM}"
network="lyra-empty-state-rehearsal-${suffix}"
database="lyra-empty-state-pg-${suffix}"
runner="lyra-empty-state-runner-${suffix}"
tls_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lyra-empty-state-tls.XXXXXX")"
cleanup() {
  docker rm -fv "$runner" >/dev/null 2>&1 || true
  docker rm -fv "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$tls_dir"
}
trap cleanup EXIT

hostname="db.yejmvtgsxniatmjbwplk.supabase.co"
wrong_ca="$tls_dir/wrong-ca.crt"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=LyraShield disposable rehearsal CA" \
  -keyout "$tls_dir/ca.key" -out "$tls_dir/ca.crt" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -subj "/CN=${hostname}" \
  -keyout "$tls_dir/server.key" -out "$tls_dir/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n' \
  "$hostname" > "$tls_dir/server.ext"
openssl x509 -req -in "$tls_dir/server.csr" -CA "$tls_dir/ca.crt" \
  -CAkey "$tls_dir/ca.key" -CAcreateserial -days 1 -sha256 \
  -extfile "$tls_dir/server.ext" -out "$tls_dir/server.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=Untrusted disposable rehearsal CA" \
  -keyout "$tls_dir/wrong-ca.key" -out "$wrong_ca" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1

docker network create --internal "$network" >/dev/null
docker create --name "$database" --network "$network" \
  --network-alias "$hostname" --network-alias wrong.invalid \
  --env POSTGRES_PASSWORD=disposable-only --env POSTGRES_DB=postgres \
  --entrypoint /bin/sh postgres:17-alpine -c \
  'chown postgres:postgres /tmp/fixture-server.crt /tmp/fixture-server.key /tmp/fixture-ca.crt; chmod 0644 /tmp/fixture-server.crt /tmp/fixture-ca.crt; chmod 0600 /tmp/fixture-server.key; exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/fixture-server.crt -c ssl_key_file=/tmp/fixture-server.key' >/dev/null
docker cp "$tls_dir/server.crt" "$database:/tmp/fixture-server.crt"
docker cp "$tls_dir/server.key" "$database:/tmp/fixture-server.key"
docker cp "$tls_dir/ca.crt" "$database:/tmp/fixture-ca.crt"
docker cp "$wrong_ca" "$database:/tmp/fixture-wrong-ca.crt"
docker start "$database" >/dev/null
pg_host="host=${hostname} hostaddr=127.0.0.1 port=5432 user=postgres dbname=postgres sslmode=verify-full sslrootcert=/tmp/fixture-ca.crt"
ready=false
for ((attempt = 1; attempt <= 30; attempt++)); do
  # The official image briefly starts a socket-only bootstrap server while
  # initializing a fresh data directory. Wait for the exact verified TCP/TLS
  # path used below so that bootstrap readiness cannot race the real server.
  tls_result="$(docker exec --env PGPASSWORD=disposable-only "$database" \
    psql --no-psqlrc --set ON_ERROR_STOP=1 "$pg_host" -Atqc \
    'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()' 2>/dev/null || true)"
  if [[ "$tls_result" == t ]]; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo "Disposable PostgreSQL did not become ready over the verified TCP/TLS path" >&2
  exit 1
fi

tls_result="$(docker exec --env PGPASSWORD=disposable-only "$database" \
  psql --no-psqlrc --set ON_ERROR_STOP=1 "$pg_host" -Atqc \
  'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')"
[[ "$tls_result" == t ]]
if docker exec --env PGPASSWORD=disposable-only "$database" \
  psql --no-psqlrc --set ON_ERROR_STOP=1 \
  "host=wrong.invalid hostaddr=127.0.0.1 port=5432 user=postgres dbname=postgres sslmode=verify-full sslrootcert=/tmp/fixture-ca.crt" \
  -Atqc 'SELECT 1' >/dev/null 2>&1; then
  echo "Disposable PostgreSQL accepted a certificate hostname mismatch" >&2
  exit 1
fi
if docker exec --env PGPASSWORD=disposable-only "$database" \
  psql --no-psqlrc --set ON_ERROR_STOP=1 \
  "host=${hostname} hostaddr=127.0.0.1 port=5432 user=postgres dbname=postgres sslmode=verify-full sslrootcert=/tmp/fixture-wrong-ca.crt" \
  -Atqc 'SELECT 1' >/dev/null 2>&1; then
  echo "Disposable PostgreSQL accepted an untrusted CA" >&2
  exit 1
fi

docker create --name "$runner" --network "container:$database" \
  --env LYRASHIELD_TEST_DB_DISPOSABLE=1 \
  --env DATABASE_DIRECT_URL='postgresql://postgres:disposable-only@127.0.0.1:5432/postgres' \
  --env DATABASE_URL='postgresql://postgres:disposable-only@127.0.0.1:5432/postgres' \
  --env LYRASHIELD_TRUSTED_FIXTURE_DATABASE_URL='postgresql://postgres:disposable-only@db.yejmvtgsxniatmjbwplk.supabase.co:5432/postgres?sslmode=verify-full' \
  --env LYRASHIELD_TRUSTED_FIXTURE_NETWORK=isolated-docker-only \
  --env NODE_EXTRA_CA_CERTS=/tmp/fixture-ca.crt \
  --env SSL_CERT_FILE=/tmp/fixture-ca.crt \
  --env PGSSLROOTCERT=/tmp/fixture-ca.crt \
  --env LYRASHIELD_TRUSTED_FIXTURE_WRONG_CA_PATH=/tmp/fixture-wrong-ca.crt \
  --env LYRASHIELD_FIXTURE_NODE_MODULES=/runtime/node_modules \
  lyra-disposable-trusted-v2:local >/dev/null
docker cp "$tls_dir/ca.crt" "$runner:/tmp/fixture-ca.crt"
docker cp "$wrong_ca" "$runner:/tmp/fixture-wrong-ca.crt"
docker start --attach "$runner"
