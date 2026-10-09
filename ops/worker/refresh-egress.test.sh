#!/bin/sh
set -eu

CDPATH=
export CDPATH
repo_root=$(cd -- "$(dirname "$0")/../.." && pwd)
grep -Fqx 'Restart=always' "$repo_root/ops/worker/lyrashield-worker.service"
grep -Fqx 'ExecStartPre=/usr/bin/env LYRASHIELD_REFRESH_PINNED_HOSTS=1 /usr/local/libexec/lyrashield-refresh-egress' "$repo_root/ops/worker/lyrashield-worker.service"
grep -Fqx 'Environment=LYRASHIELD_REFRESH_PINNED_HOSTS=1' "$repo_root/ops/worker/lyrashield-worker-egress.service"
if grep -Rq 'LYRASHIELD_RESTART_WORKER_ON_PIN_CHANGE\|try-restart lyrashield-worker' \
  "$repo_root/ops/worker/refresh-egress.sh" \
  "$repo_root/ops/worker/lyrashield-worker-egress-refresh.service"; then
  echo "Normal pin refresh still schedules a worker restart" >&2
  exit 1
fi
if grep -Eq 'egress-drain|planned-restart|handoffScanWorker|acknowledgeEgressDrainRequest|deactivateScanWorkerForDrain|failClosedAfterEgressDrainCancellation|finalizeScanWorkerRegistrationForShutdown' \
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
iptables_commands="$test_dir/iptables-commands"
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
case "$2" in
  "${NOTIFICATION_PRIVATE_HOST:-}") echo "10.0.0.8 STREAM $2" ;;
  proxy.test) echo "8.8.4.4 STREAM proxy.test" ;;
  hooks.slack.com) echo "1.1.1.1 STREAM hooks.slack.com" ;;
  discord.com) echo "1.0.0.1 STREAM discord.com" ;;
  *) echo "8.8.8.8 STREAM $2" ;;
esac
EOF

cat >"$fake_bin/iptables" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$IPTABLES_COMMANDS"
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
    *'.Driver'*) echo "${SANDBOX_TOPOLOGY:-bridge|true|false}" ;;
    *'.Id'*) echo '0123456789abcdef0123456789abcdef' ;;
    *Subnet*)
      if [ "$3" = "bridge" ]; then echo "172.17.0.0/16"; else echo "172.18.0.0/16"; fi
      ;;
    *bridge.name*)
      if [ "$3" = "bridge" ]; then echo "docker0"; else echo "${SANDBOX_BRIDGE-br-sandbox}"; fi
      ;;
    *) exit 1 ;;
  esac
  exit
fi

if [ "$1" = "inspect" ]; then
  [ "${WORKER_INSPECT_EXISTS:-1}" = "1" ] || exit 1
  printf '%s\n' "${WORKER_NETWORKS:-bridge}"
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
  : >"$iptables_commands"
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
  IPTABLES_COMMANDS="$iptables_commands" \
  VERIFY_LOG="$verify_log" \
  HOST_UPDATE_FAIL="${HOST_UPDATE_FAIL:-0}" \
  HOST_VERIFY_FAIL="${HOST_VERIFY_FAIL:-0}" \
  IPTABLES_FAIL_CALL="${IPTABLES_FAIL_CALL:-0}" \
  NOTIFICATION_PRIVATE_HOST="${NOTIFICATION_PRIVATE_HOST:-}" \
  SANDBOX_BRIDGE="${SANDBOX_BRIDGE-br-sandbox}" \
  SANDBOX_TOPOLOGY="${SANDBOX_TOPOLOGY:-bridge|true|false}" \
  WORKER_NETWORKS="${WORKER_NETWORKS:-bridge}" \
  WORKER_INSPECT_EXISTS="${WORKER_INSPECT_EXISTS:-1}" \
  LYRASHIELD_REQUIRE_SANDBOX_CONTROL="${REQUIRE_SANDBOX_CONTROL:-0}" \
  LYRASHIELD_WORKER_ENV_FILE="$environment_file" \
  LYRASHIELD_EGRESS_PIN_FILE="$pin_file" \
  LYRASHIELD_REFRESH_PINNED_HOSTS="${REFRESH_PINNED_HOSTS:-1}" \
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
grep -Fqx 'api.polar.sh 8.8.8.8 443' "$pin_file"
grep -Fqx 'api.razorpay.com 8.8.8.8 443' "$pin_file"
if ! grep -Fqx 'hooks.slack.com 1.1.1.1 443' "$pin_file" || \
   ! grep -Fqx 'discord.com 1.0.0.1 443' "$pin_file"; then
  echo "Notification destinations are missing HTTPS egress pins" >&2
  exit 1
fi
grep -Fqx '1.1.1.1 hooks.slack.com' "$container_hosts"
grep -Fqx '1.0.0.1 discord.com' "$container_hosts"
grep -q '^CALL 1$' "$iptables_log"
grep -q '^CALL 2$' "$iptables_log"
first_rules=$(sed -n '/^CALL 1$/,/^CALL 2$/p' "$iptables_log")
printf '%s\n' "$first_rules" | grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT'
printf '%s\n' "$first_rules" | grep -q -- '-d 8.8.8.8 --dport 443 -j ACCEPT'
printf '%s\n' "$first_rules" | grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT'
second_rules=$(sed -n '/^CALL 2$/,$p' "$iptables_log")
printf '%s\n' "$second_rules" | grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT'
printf '%s\n' "$second_rules" | grep -Fqx -- '-A LYRASHIELD-EGRESS -p tcp -d 1.1.1.1 --dport 443 -j ACCEPT'
printf '%s\n' "$second_rules" | grep -Fqx -- '-A LYRASHIELD-EGRESS -p tcp -d 1.0.0.1 --dport 443 -j ACCEPT'
printf '%s\n' "$second_rules" | grep -Fqx -- '-A LYRASHIELD-EGRESS -j REJECT --reject-with icmp-admin-prohibited'
if printf '%s\n' "$second_rules" | grep -Eq -- '-d (1\.1\.1\.1|1\.0\.0\.1) --dport (80|[0-9]+:[0-9]+) -j ACCEPT'; then
  echo "Notification destinations have a non-HTTPS firewall allowance" >&2
  exit 1
fi
if printf '%s\n' "$second_rules" | grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT'; then
  echo "Successful refresh retained an obsolete firewall pin" >&2
  exit 1
fi
grep -Fq 'Worker egress pins changed; hosts:' "$output_file"

# Worker traffic enters from docker0. Sandboxes arrive from their isolated
# bridge, so even a sandbox spoofing the worker IP cannot enter this chain.
# Evaluate the script's emitted USER jump and managed chain for TCP/UDP packets;
# unmatched traffic remains subject to Docker's internal-network/ICC denial.
sandbox_verdict() {
  awk -v source="$1" -v destination="$2" -v destination_port="$3" \
    -v state="$4" -v inbound="$5" -v outbound="$6" -v protocol="$7" '
    function address_number(address, octets) {
      split(address, octets, ".")
      return ((octets[1] * 256 + octets[2]) * 256 + octets[3]) * 256 + octets[4]
    }
    function matches(address, network, parts, size) {
      split(network, parts, "/")
      if (parts[2] == "") return address == network
      size = 2 ^ (32 - parts[2])
      return int(address_number(address) / size) == int(address_number(parts[1]) / size)
    }
    function packet_matches( field, matched) {
      matched = 1
      for (field = 1; field <= NF; field++) {
        if ($field == "-s" && !matches(source, $(field + 1))) matched = 0
        if ($field == "-d" && !matches(destination, $(field + 1))) matched = 0
        if ($field == "--dport" && destination_port != $(field + 1)) matched = 0
        if ($field == "--ctstate" && index("," $(field + 1) ",", "," state ",") == 0) matched = 0
        if ($field == "-i" && inbound != $(field + 1)) matched = 0
        if ($field == "-o" && outbound != $(field + 1)) matched = 0
        if ($field == "-p" && protocol != $(field + 1)) matched = 0
      }
      return matched
    }
    NR == FNR {
      if ($1 == "-I" && $2 == "DOCKER-USER" && $NF == "LYRASHIELD-EGRESS" && packet_matches()) admitted = 1
      next
    }
    /^CALL / { verdict = "DENY"; decided = 0 }
    $1 == "-A" && $2 == "LYRASHIELD-EGRESS" && admitted && !decided && packet_matches() {
      for (field = 3; field <= NF; field++) if ($field == "-j") action = $(field + 1)
      verdict = action == "ACCEPT" ? "ACCEPT" : "DENY"
      decided = 1
    }
    END { print verdict }
  ' "$iptables_commands" "$iptables_log"
}

test "$(sandbox_verdict 172.17.0.2 172.18.0.3 48080 NEW docker0 br-sandbox tcp)" = ACCEPT
if [ "$(sandbox_verdict 172.17.0.2 172.18.0.3 80 NEW docker0 br-sandbox tcp)" != DENY ]; then
  echo "Worker sandbox access is broader than the TCP 48080 control server" >&2
  exit 1
fi
test "$(sandbox_verdict 172.17.0.2 172.18.0.3 48080 NEW docker0 br-sandbox udp)" = DENY
test "$(sandbox_verdict 172.17.0.2 172.18.0.3 48080 NEW docker0 docker0 tcp)" = DENY
test "$(sandbox_verdict 172.18.0.4 172.18.0.3 48080 NEW br-sandbox br-sandbox tcp)" = DENY
test "$(sandbox_verdict 172.17.0.2 172.18.0.3 48080 NEW br-sandbox br-sandbox tcp)" = DENY
test "$(sandbox_verdict 172.17.0.2 172.19.0.3 48080 NEW docker0 br-sandbox tcp)" = DENY

# Docker derives br-<first 12 ID chars> when the bridge is not explicitly named.
reset_state
export SANDBOX_BRIDGE=''
run_refresh "$output_file" "$error_file"
unset SANDBOX_BRIDGE
test "$(sandbox_verdict 172.17.0.2 172.18.0.3 48080 NEW docker0 br-0123456789ab tcp)" = ACCEPT
reset_state
export SANDBOX_BRIDGE='bridge;injected'
if run_refresh "$output_file" "$error_file"; then
  echo "Egress accepted an invalid sandbox bridge interface" >&2
  exit 1
fi
unset SANDBOX_BRIDGE
test ! -s "$iptables_log"

# Launch-time policy does not need an allocated IP from a stopped container.
# Its required mode checks an exact bridge-only attachment before consumer start.
reset_state
: >"$worker_running"
export REQUIRE_SANDBOX_CONTROL=1
run_refresh "$output_file" "$error_file"
test "$(sandbox_verdict 172.17.0.2 172.18.0.3 48080 NEW docker0 br-sandbox tcp)" = ACCEPT
for invalid_networks in 'bridge lyrashield-sandbox' 'lyrashield-sandbox' 'host'; do
  reset_state
  export WORKER_NETWORKS="$invalid_networks"
  if run_refresh "$output_file" "$error_file"; then
    echo "Required control policy accepted worker network drift" >&2
    exit 1
  fi
  test ! -s "$iptables_log"
done
unset WORKER_NETWORKS
reset_state
export WORKER_INSPECT_EXISTS=0
if run_refresh "$output_file" "$error_file"; then
  echo "Required control policy accepted a missing worker container" >&2
  exit 1
fi
unset WORKER_INSPECT_EXISTS
test ! -s "$iptables_log"

for unsafe_topology in 'bridge|false|false' 'bridge|true|true' 'overlay|true|false'; do
  reset_state
  export SANDBOX_TOPOLOGY="$unsafe_topology"
  if run_refresh "$output_file" "$error_file"; then
    echo "Required control policy accepted an unsafe sandbox network" >&2
    exit 1
  fi
  test ! -s "$iptables_log"
done
unset SANDBOX_TOPOLOGY REQUIRE_SANDBOX_CONTROL

# Notification DNS must remain public. Reject either host before mutating the
# firewall, persisted pins, or running-container hosts.
for notification_host in hooks.slack.com discord.com; do
  reset_state
  export NOTIFICATION_PRIVATE_HOST="$notification_host"
  if run_refresh "$output_file" "$error_file"; then
    echo "Refresh accepted a private notification destination: $notification_host" >&2
    exit 1
  fi
  unset NOTIFICATION_PRIVATE_HOST
  grep -Fq "non-public IPv4 address: $notification_host" "$error_file"
  test ! -s "$iptables_log"
  test ! -s "$verify_log"
  grep -Fqx 'proxy.test 9.9.9.9 443' "$pin_file"
  grep -Fqx '9.9.9.9 proxy.test' "$container_hosts"
done

# Enabling known notification destinations must not make unknown persisted
# endpoints valid outside an explicit old/new pin rotation.
reset_state
printf '%s\n' 'webhook.attacker.test 9.9.9.8 443' >>"$pin_file"
export REFRESH_PINNED_HOSTS=0
if run_refresh "$output_file" "$error_file"; then
  echo "Refresh accepted an unapproved webhook host" >&2
  exit 1
fi
unset REFRESH_PINNED_HOSTS
grep -Fq 'unapproved host or port' "$error_file"
test ! -s "$iptables_log"
test ! -s "$verify_log"

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

# A rotated Redis host stays available only for the transition union. The
# refreshed pin file and final firewall must contain the configured host only.
reset_state
printf '%s\n' 'retired-redis.test 9.9.9.9 6379' >"$pin_file"
run_refresh "$output_file" "$error_file"
grep -Fqx 'redis.test 8.8.8.8 6379' "$pin_file"
if grep -Fq 'retired-redis.test' "$pin_file"; then
  echo "Redis rotation retained the retired pin" >&2
  exit 1
fi
first_rules=$(sed -n '/^CALL 1$/,/^CALL 2$/p' "$iptables_log")
printf '%s\n' "$first_rules" | grep -q -- '-d 9.9.9.9 --dport 6379 -j ACCEPT'
second_rules=$(sed -n '/^CALL 2$/,$p' "$iptables_log")
if printf '%s\n' "$second_rules" | grep -q -- '-d 9.9.9.9 --dport 6379 -j ACCEPT'; then
  echo "Redis rotation retained the retired firewall pin" >&2
  exit 1
fi

# Stable pins do not touch the running container and never schedule a restart.
reset_state
printf '%s\n' \
  'ai.test 8.8.8.8 443' \
  'api.first.org 8.8.8.8 443' \
  'api.github.com 8.8.8.8 443' \
  'api.osv.dev 8.8.8.8 443' \
  'api.polar.sh 8.8.8.8 443' \
  'api.parallel.ai 8.8.8.8 443' \
  'api.razorpay.com 8.8.8.8 443' \
  'db.test 8.8.8.8 5432' \
  'discord.com 1.0.0.1 443' \
  'github.com 8.8.8.8 443' \
  'hooks.slack.com 1.1.1.1 443' \
  'proxy.test 8.8.4.4 443' \
  'redis.test 8.8.8.8 6379' \
  'storage.test 8.8.8.8 443' >"$pin_file"
run_refresh "$output_file" "$error_file"
test ! -s "$output_file"
if grep -Fq -- '--user 0:0 -i' "$docker_log"; then
  echo "Stable refresh rewrote running-container hosts" >&2
  exit 1
fi
# Previously pinned notification hosts remain approved without a DNS rotation.
export REFRESH_PINNED_HOSTS=0
run_refresh "$output_file" "$error_file"
unset REFRESH_PINNED_HOSTS
test ! -s "$output_file"

# The notification allowlist grants HTTPS only, including when loading pins.
for notification_host in hooks.slack.com discord.com; do
  reset_state
  printf '%s 1.1.1.1 80\n' "$notification_host" >>"$pin_file"
  export REFRESH_PINNED_HOSTS=0
  if run_refresh "$output_file" "$error_file"; then
    echo "Refresh accepted a non-HTTPS notification pin: $notification_host" >&2
    exit 1
  fi
  unset REFRESH_PINNED_HOSTS
  grep -Fq 'unapproved host or port' "$error_file"
  test ! -s "$iptables_log"
done

cat >>"$environment_file" <<'EOF'
LYRASHIELD_AI_RESULT_CACHE_MODE=enforce
LYRASHIELD_AI_CACHE_REDIS_URL=rediss://default:cache-secret@cache.test:6380
EOF
reset_state
run_refresh "$output_file" "$error_file"
grep -Fqx 'cache.test 8.8.8.8 6380' "$pin_file"
first_rules=$(sed -n '/^CALL 1$/,/^CALL 2$/p' "$iptables_log")
printf '%s\n' "$first_rules" | grep -q -- '-d 8.8.8.8 --dport 6380 -j ACCEPT'
second_rules=$(sed -n '/^CALL 2$/,$p' "$iptables_log")
printf '%s\n' "$second_rules" | grep -q -- '-d 8.8.8.8 --dport 6380 -j ACCEPT'

# Turning the cache off drops the dedicated endpoint from refreshed pins and
# the final firewall rules after the normal old/new transition window.
cat >"$environment_file" <<'EOF'
DATABASE_URL=postgresql://db.test:5432/lyrashield
REDIS_URL=rediss://redis.test:6379
AZURE_AI_API_BASE=https://ai.test
S3_ENDPOINT=https://storage.test
LYRASHIELD_EGRESS_PROXY_URL=https://proxy.test
LYRASHIELD_AI_RESULT_CACHE_MODE=off
EOF
reset_state
printf '%s\n' 'cache.test 8.8.8.8 6380' >>"$pin_file"
run_refresh "$output_file" "$error_file"
if grep -Fq 'cache.test 6380' "$pin_file"; then
  echo "Disabled exact result cache retained its egress pin" >&2
  exit 1
fi
last_rules=$(sed -n '/^CALL 2$/,$p' "$iptables_log")
if printf '%s\n' "$last_rules" | grep -q -- '-d 8.8.8.8 --dport 6380 -j ACCEPT'; then
  echo "Disabled exact result cache retained its firewall allowance" >&2
  exit 1
fi

echo "refresh-egress live pin-rotation test passed"
