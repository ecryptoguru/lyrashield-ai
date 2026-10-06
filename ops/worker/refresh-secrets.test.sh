#!/bin/sh
set -eu

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

mkdir -p "$test_root/bin" "$test_root/etc"
cat >"$test_root/bin/az" <<'EOF'
#!/bin/sh
set -eu
if [ "${1:-}" = login ]; then
  exit 0
fi
secret_name=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --name ]; then
    secret_name=$2
    break
  fi
  shift
done
case "$secret_name" in
  worker-evidence-kek-config-ref)
    [ -n "${FAKE_CONFIG_REF:-}" ] || exit 1
    printf '%s\n' "$FAKE_CONFIG_REF"
    ;;
  worker-evidence-kek-active-ref)
    [ -n "${FAKE_ACTIVE_REF:-}" ] || exit 1
    printf '%s\n' "$FAKE_ACTIVE_REF"
    ;;
  worker-evidence-kek-v1|worker-evidence-kek)
    printf '%s\n' active-v1
    ;;
  worker-evidence-kek-keyring-a6508cef8ba6)
    printf '%s\n' '{"envkeystore/lyrashield-evidence-kek/v2":"future"}'
    ;;
  worker-evidence-kek-keyring-v1)
    printf '%s\n' '{}'
    ;;
  worker-ai-result-cache-mode)
    if [ "${FAKE_CACHE_MODE+x}" = x ]; then
      printf '%s\n' "$FAKE_CACHE_MODE"
    else
      exit 1
    fi
    ;;
  worker-ai-cache-fingerprint)
    printf '%s\n' "${FAKE_CACHE_FINGERPRINT:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
    ;;
  worker-ai-cache-url)
    printf '%s\n' "${FAKE_CACHE_URL:-rediss://default:cache-secret@cache.test:6379}"
    ;;
  worker-ai-cache-key)
    printf '%s\n' "${FAKE_CACHE_KEY:-cache-key-secret-sentinel-0123456789}"
    ;;
  ip-hash-salt)
    printf '%s\n' "${FAKE_IP_HASH_SALT:-test-ip-hash-salt-for-worker-config-32-characters}"
    ;;
  *)
    printf 'value-%s\n' "$secret_name"
    ;;
esac
EOF
chmod +x "$test_root/bin/az"

cat >"$test_root/etc/runtime.conf" <<'EOF'
LYRASHIELD_WORKER_IMAGE=registry.azurecr.io/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
LYRASHIELD_SANDBOX_IMAGE=registry.azurecr.io/sandbox@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
EOF

run_refresh() {
  env_file=$1
  shift
  env \
    PATH="$test_root/bin:$PATH" \
    AZURE_CONFIG_DIR="$test_root/azure" \
    LYRASHIELD_WORKER_RUNTIME_CONFIG="$test_root/etc/runtime.conf" \
    LYRASHIELD_WORKER_ENV_FILE="$env_file" \
    "$@" \
    sh "$script_dir/refresh-secrets.sh"
}

config_env="$test_root/etc/config.env"
run_refresh "$config_env" FAKE_CONFIG_REF=v1/a6508cef8ba6
grep -Fqx 'LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF=envkeystore/lyrashield-evidence-kek/v1' "$config_env"
grep -Fqx 'LYRASHIELD_EVIDENCE_KEK=active-v1' "$config_env"
grep -Fqx 'LYRASHIELD_EVIDENCE_KEK_KEYRING={"envkeystore/lyrashield-evidence-kek/v2":"future"}' "$config_env"
grep -Fqx 'IP_HASH_SALT=test-ip-hash-salt-for-worker-config-32-characters' "$config_env"
grep -Fqx 'POLAR_ENVIRONMENT=value-worker-polar-environment' "$config_env"
grep -Fqx 'POLAR_ACCESS_TOKEN=value-worker-polar-access-token' "$config_env"
grep -Fqx 'RAZORPAY_KEY_ID=value-worker-razorpay-key-id' "$config_env"
grep -Fqx 'RAZORPAY_KEY_SECRET=value-worker-razorpay-key-secret' "$config_env"
grep -Fqx 'LYRASHIELD_AI_RESULT_CACHE_MODE=off' "$config_env"
if grep -Eq '^LYRASHIELD_AI_CACHE_(REDIS_URL|KEY_SECRET|PROVIDER_FINGERPRINT)=' "$config_env"; then
  echo "Default-off exact result cache unexpectedly loaded credentials" >&2
  exit 1
fi

cache_env="$test_root/etc/cache.env"
run_refresh "$cache_env" \
  FAKE_CACHE_MODE=observe \
  FAKE_CACHE_FINGERPRINT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
grep -Fqx 'LYRASHIELD_AI_RESULT_CACHE_MODE=observe' "$cache_env"
grep -Fqx 'LYRASHIELD_AI_CACHE_PROVIDER_FINGERPRINT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$cache_env"
grep -Fqx 'LYRASHIELD_AI_CACHE_REDIS_URL=rediss://default:cache-secret@cache.test:6379' "$cache_env"
grep -Fqx 'LYRASHIELD_AI_CACHE_KEY_SECRET=cache-key-secret-sentinel-0123456789' "$cache_env"

invalid_cache_env="$test_root/etc/invalid-cache.env"
printf '%s\n' 'PRESERVE=invalid-cache' >"$invalid_cache_env"
if run_refresh "$invalid_cache_env" FAKE_CACHE_MODE=enabled 2>"$test_root/invalid-cache.stderr"; then
  echo "Invalid exact result-cache mode unexpectedly succeeded" >&2
  exit 1
fi
grep -Fqx 'Worker exact AI-result cache mode is invalid' "$test_root/invalid-cache.stderr"
grep -Fqx 'PRESERVE=invalid-cache' "$invalid_cache_env"

short_cache_key_env="$test_root/etc/short-cache-key.env"
printf '%s\n' 'PRESERVE=short-cache-key' >"$short_cache_key_env"
if run_refresh "$short_cache_key_env" FAKE_CACHE_MODE=enforce FAKE_CACHE_KEY=short 2>"$test_root/short-cache-key.stderr"; then
  echo "Short exact result-cache key unexpectedly succeeded" >&2
  exit 1
fi
grep -Fqx 'Worker exact AI-result cache key must contain at least 32 bytes' "$test_root/short-cache-key.stderr"
grep -Fqx 'PRESERVE=short-cache-key' "$short_cache_key_env"

active_ref_env="$test_root/etc/active-ref.env"
run_refresh "$active_ref_env" \
  FAKE_ACTIVE_REF=envkeystore/lyrashield-evidence-kek/v1
grep -Fqx 'LYRASHIELD_EVIDENCE_KEK=active-v1' "$active_ref_env"
grep -Fqx 'LYRASHIELD_EVIDENCE_KEK_KEYRING={}' "$active_ref_env"

legacy_env="$test_root/etc/legacy.env"
run_refresh "$legacy_env"
grep -Fqx 'LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF=envkeystore/lyrashield-evidence-kek/v1' "$legacy_env"
grep -Fqx 'LYRASHIELD_EVIDENCE_KEK=active-v1' "$legacy_env"
grep -Fqx 'LYRASHIELD_EVIDENCE_KEK_KEYRING={}' "$legacy_env"

short_salt_env="$test_root/etc/short-salt.env"
printf '%s\n' 'PRESERVE=short-salt' >"$short_salt_env"
if run_refresh "$short_salt_env" FAKE_IP_HASH_SALT=short 2>"$test_root/short-salt.stderr"; then
  echo "Short IP hash salt unexpectedly succeeded" >&2
  exit 1
fi
grep -Fqx 'IP hash salt must contain at least 32 characters' "$test_root/short-salt.stderr"
grep -Fqx 'PRESERVE=short-salt' "$short_salt_env"

invalid_env="$test_root/etc/invalid.env"
printf '%s\n' 'PRESERVE=existing' >"$invalid_env"
if run_refresh "$invalid_env" FAKE_CONFIG_REF=malformed 2>"$test_root/invalid.stderr"; then
  echo "Malformed config selector unexpectedly succeeded" >&2
  exit 1
fi
grep -Fqx 'Evidence KEK config ref is invalid' "$test_root/invalid.stderr"
grep -Fqx 'PRESERVE=existing' "$invalid_env"

digest_env="$test_root/etc/digest.env"
printf '%s\n' 'PRESERVE=digest' >"$digest_env"
if run_refresh "$digest_env" FAKE_CONFIG_REF=v1/000000000000 2>"$test_root/digest.stderr"; then
  echo "Mismatched keyring digest unexpectedly succeeded" >&2
  exit 1
fi
grep -Fqx 'Evidence KEK keyring digest does not match config ref' "$test_root/digest.stderr"
grep -Fqx 'PRESERVE=digest' "$digest_env"

printf '%s\n' 'refresh-secrets tests passed'
