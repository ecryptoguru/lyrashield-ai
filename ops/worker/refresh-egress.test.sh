#!/bin/sh
set -eu

CDPATH=
export CDPATH
repo_root=$(cd -- "$(dirname "$0")/../.." && pwd)
grep -Fqx 'Restart=always' "$repo_root/ops/worker/lyrashield-worker.service"
grep -Fqx 'ExecStartPre=/usr/bin/env LYRASHIELD_REFRESH_PINNED_HOSTS=1 /usr/local/libexec/lyrashield-refresh-egress' "$repo_root/ops/worker/lyrashield-worker.service"
if grep -Rq 'LYRASHIELD_RESTART_WORKER_ON_PIN_CHANGE\|try-restart lyrashield-worker' \
  "$repo_root/ops/worker/refresh-egress.sh" \
  "$repo_root/ops/worker/lyrashield-worker-egress-refresh.service"; then
  echo "Normal pin refresh still schedules a worker restart" >&2
  exit 1
fi
if grep -Eq 'egress-drain|planned-restart|handoffScanWorker' \
  "$repo_root/apps/worker/src/index.ts" \
  "$repo_root/packages/integrations/src/queue.ts"; then
  echo "Worker still contains the obsolete pin-refresh restart handshake" >&2
  exit 1
fi

test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
fake_bin="$test_dir/bin"
mkdir -p "$fake_bin"

environment_file="$test_dir/worker.env"
pin_file="$test_dir/pins"
container_hosts="$test_dir/container-hosts"
container_hosts_backup="$test_dir/container-hosts-backup"
container_pins="$test_dir/container-pins"
container_approved="$test_dir/container-approved"
docker_log="$test_dir/docker.log"
iptables_log="$test_dir/iptables.log"
iptables_count="$test_dir/iptables-count"
verify_log="$test_dir/verify.log"
worker_running="$test_dir/worker-running"

cat >"$environment_file" <<'EOF'
DATABASE_URL=postgresql://db.test:5432/lyrashield
REDIS_URL=rediss://redis.test:6379
AZURE_AI_API_BASE=https://ai.test
S3_ENDPOINT=https://storage.test
LYRASHIELD_EGRESS_PROXY_URL=https://proxy.test
EOF

cat >"$fake_bin/getent" <<'EOF'
#!/bin/sh
if [ "$2" = "proxy.test" ]; then
  echo "8.8.4.4 STREAM proxy.test"
else
  echo "8.8.8.8 STREAM $2"
fi
EOF

cat >"$fake_bin/iptables" <<'EOF'
#!/bin/sh
case "$1" in
  -N | -C) exit 1 ;;
  *) exit 0 ;;
esac
EOF

cat >"$fake_bin/iptables-restore" <<'EOF'
#!/bin/sh
count=0
[ ! -s "$IPTABLES_COUNT" ] || count=$(cat "$IPTABLES_COUNT")
count=$((count + 1))
printf '%s\n' "$count" >"$IPTABLES_COUNT"
rules=$(cat)
if [ "${IPTABLES_FAIL_CALL:-0}" = "$count" ]; then
  exit 1
fi
{
  printf '%s\n' "CALL $count"
  printf '%s\n' "$rules"
} >>"$IPTABLES_LOG"
EOF

cat >"$fake_bin/systemctl" <<'EOF'
#!/bin/sh
echo "Unexpected systemctl invocation: $*" >&2
exit 1
EOF

cat >"$fake_bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$DOCKER_LOG"

if [ "$1" = "network" ]; then
  case "$5" in
    *Subnet*)
      if [ "$3" = "bridge" ]; then echo "172.17.0.0/16"; else echo "172.18.0.0/16"; fi
      ;;
    *bridge.name*) echo "docker0" ;;
    *) exit 1 ;;
  esac
  exit
fi

[ "$1" = "exec" ] || exit 1
shift
if [ "${1:-}" = "--user" ]; then shift 2; fi
interactive=0
if [ "${1:-}" = "-i" ]; then interactive=1; shift; fi
[ "${1:-}" = "lyrashield-worker" ] || exit 1
shift

if [ "${1:-}" = "true" ]; then
  [ -s "$WORKER_RUNNING" ]
  exit
fi
if [ "${1:-}" = "rm" ]; then
  exit
fi
[ "${1:-}" = "sh" ] && [ "${2:-}" = "-c" ] || exit 1
script=$3
shift 3

case "$script" in
  *'cat > "$1"'*)
    [ "$interactive" = "1" ] || exit 1
    destination=$2
    case "$destination" in
      *.pins) cat >"$CONTAINER_PINS" ;;
      *.approved) cat >"$CONTAINER_APPROVED" ;;
      *) exit 1 ;;
    esac
    ;;
  *'cp /etc/hosts "$backup"'*)
    cp "$CONTAINER_HOSTS" "$CONTAINER_HOSTS_BACKUP"
    if [ "${HOST_UPDATE_FAIL:-0}" = "1" ]; then
      exit 1
    fi
    awk '
      NR == FNR { approved[$1] = 1; next }
      {
        keep = 1
        for (field = 2; field <= NF; field++) {
          if ($field in approved) keep = 0
        }
        if (keep) print
      }
    ' "$CONTAINER_APPROVED" "$CONTAINER_HOSTS_BACKUP" >"$CONTAINER_HOSTS"
    awk '{ print $2 " " $1 }' "$CONTAINER_PINS" >>"$CONTAINER_HOSTS"
    ;;
  *'getent ahostsv4'*)
    printf '%s\n' verified >"$VERIFY_LOG"
    [ "${HOST_VERIFY_FAIL:-0}" != "1" ]
    ;;
  *'test -s "$1" && cat "$1" > /etc/hosts'*)
    [ -s "$CONTAINER_HOSTS_BACKUP" ] && cp "$CONTAINER_HOSTS_BACKUP" "$CONTAINER_HOSTS"
    ;;
  *) exit 1 ;;
esac
EOF

chmod +x "$fake_bin"/*

reset_state() {
  printf '%s\n' 'proxy.test 9.9.9.9 443' >"$pin_file"
  cat >"$container_hosts" <<'EOF'
127.0.0.1 localhost
172.17.0.2 worker-container
9.9.9.9 proxy.test
7.7.7.7 www.cisa.gov
EOF
  : >"$docker_log"
  : >"$iptables_log"
  : >"$iptables_count"
  : >"$container_hosts_backup"
  : >"$verify_log"
  printf '%s\n' running >"$worker_running"
}

run_refresh() {
  output_file="$1"
  error_file="$2"
  PATH="$fake_bin:$PATH" \
  WORKER_RUNNING="$worker_running" \
  CONTAINER_HOSTS="$container_hosts" \
  CONTAINER_HOSTS_BACKUP="$container_hosts_backup" \
  CONTAINER_PINS="$container_pins" \
  CONTAINER_APPROVED="$container_approved" \
  DOCKER_LOG="$docker_log" \
  IPTABLES_LOG="$iptables_log" \
  IPTABLES_COUNT="$iptables_count" \
  VERIFY_LOG="$verify_log" \
  HOST_UPDATE_FAIL="${HOST_UPDATE_FAIL:-0}" \
  HOST_VERIFY_FAIL="${HOST_VERIFY_FAIL:-0}" \
  IPTABLES_FAIL_CALL="${IPTABLES_FAIL_CALL:-0}" \
  LYRASHIELD_WORKER_ENV_FILE="$environment_file" \
  LYRASHIELD_EGRESS_PIN_FILE="$pin_file" \
  LYRASHIELD_REFRESH_PINNED_HOSTS=1 \
  sh "$repo_root/ops/worker/refresh-egress.sh" >"$output_file" 2>"$error_file"
}

output_file="$test_dir/output"
error_file="$test_dir/error"

# Success: union first, verified live hosts second, committed pins third, new-only last.
reset_state
run_refresh "$output_file" "$error_file"
test -s "$verify_log"
grep -Fqx '127.0.0.1 localhost' "$container_hosts"
grep -Fqx '172.17.0.2 worker-container' "$container_hosts"
grep -Fqx '8.8.4.4 proxy.test' "$container_hosts"
if grep -Fq '9.9.9.9 proxy.test' "$container_hosts"; then
  echo "Successful refresh retained an obsolete hosts entry" >&2
  exit 1
fi
if grep -Fq 'www.cisa.gov' "$container_hosts"; then
  echo "Successful refresh retained the staged legacy CISA hosts entry" >&2
  exit 1
fi
grep -Fqx 'proxy.test 8.8.4.4 443' "$pin_file"
grep -q '^CALL 1$' "$iptables_log"
grep -q '^CALL 2$' "$iptables_log"
first_rules=$(sed -n '/^CALL 1$/,/^CALL 2$/p' "$iptables_log")
printf '%s\n' "$first_rules" | grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT'
printf '%s\n' "$first_rules" | grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT'
second_rules=$(sed -n '/^CALL 2$/,$p' "$iptables_log")
printf '%s\n' "$second_rules" | grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT'
if printf '%s\n' "$second_rules" | grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT'; then
  echo "Successful refresh retained an obsolete firewall pin" >&2
  exit 1
fi
grep -Fq 'Worker egress pins changed; hosts:' "$output_file"

# Update failure: old hosts and pin file survive; union remains active.
reset_state
export HOST_UPDATE_FAIL=1
if run_refresh "$output_file" "$error_file"; then
  echo "Refresh ignored running-container hosts update failure" >&2
  exit 1
fi
unset HOST_UPDATE_FAIL
grep -Fqx '9.9.9.9 proxy.test' "$container_hosts"
grep -Fqx 'proxy.test 9.9.9.9 443' "$pin_file"
grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT' "$iptables_log"
grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT' "$iptables_log"
grep -Fq 'retained old pins and old/new firewall union' "$error_file"

# Verification failure rolls back the already-updated hosts before failing closed.
reset_state
export HOST_VERIFY_FAIL=1
if run_refresh "$output_file" "$error_file"; then
  echo "Refresh ignored running-container hosts verification failure" >&2
  exit 1
fi
unset HOST_VERIFY_FAIL
grep -Fqx '9.9.9.9 proxy.test' "$container_hosts"
grep -Fqx 'proxy.test 9.9.9.9 443' "$pin_file"

# New-only firewall failure rolls back hosts and committed pin, then restores union.
reset_state
export IPTABLES_FAIL_CALL=2
if run_refresh "$output_file" "$error_file"; then
  echo "Refresh ignored final firewall failure" >&2
  exit 1
fi
unset IPTABLES_FAIL_CALL
grep -Fqx '9.9.9.9 proxy.test' "$container_hosts"
grep -Fqx 'proxy.test 9.9.9.9 443' "$pin_file"
grep -q '^CALL 3$' "$iptables_log"
last_rules=$(sed -n '/^CALL 3$/,$p' "$iptables_log")
printf '%s\n' "$last_rules" | grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT'
printf '%s\n' "$last_rules" | grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT'

# Stable pins do not touch the running container and never schedule a restart.
reset_state
printf '%s\n' \
  'ai.test 8.8.8.8 443' \
  'api.first.org 8.8.8.8 443' \
  'api.github.com 8.8.8.8 443' \
  'api.osv.dev 8.8.8.8 443' \
  'api.parallel.ai 8.8.8.8 443' \
  'db.test 8.8.8.8 5432' \
  'github.com 8.8.8.8 443' \
  'proxy.test 8.8.4.4 443' \
  'redis.test 8.8.8.8 6379' \
  'storage.test 8.8.8.8 443' >"$pin_file"
run_refresh "$output_file" "$error_file"
test ! -s "$output_file"
if grep -Fq -- '--user 0:0 -i' "$docker_log"; then
  echo "Stable refresh rewrote running-container hosts" >&2
  exit 1
fi

echo "refresh-egress live pin-rotation test passed"
