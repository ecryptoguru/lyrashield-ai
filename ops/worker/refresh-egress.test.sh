#!/bin/sh
set -eu

CDPATH=
export CDPATH
repo_root=$(cd -- "$(dirname "$0")/../.." && pwd)
grep -Fqx 'Restart=always' "$repo_root/ops/worker/lyrashield-worker.service"
grep -Fqx 'ExecStartPre=/usr/bin/env LYRASHIELD_REFRESH_PINNED_HOSTS=1 LYRASHIELD_CLEAR_PENDING_RESTART=1 /usr/local/libexec/lyrashield-refresh-egress' "$repo_root/ops/worker/lyrashield-worker.service"
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
fake_bin="$test_dir/bin"
restart_pending_file="$test_dir/restart-pending"
docker_capture="$test_dir/docker.log"
getent_capture="$test_dir/getent.log"
drain_request_capture="$test_dir/drain-request"
planned_restart_capture="$test_dir/planned-restart"
worker_running_capture="$test_dir/worker-running"
activity_transition_capture="$test_dir/activity-transition"
mkdir -p "$fake_bin"

cat >"$fake_bin/docker" <<'EOF'
#!/bin/sh
if [ "$1" = "exec" ]; then
  case "$3" in
    true) [ -s "$WORKER_RUNNING_CAPTURE" ] ;;
    test)
      case "$5" in
        /tmp/lyrashield-worker-active) [ "${DOCKER_WORKER_ACTIVE:-0}" = "1" ] ;;
        *) exit 1 ;;
      esac
      ;;
    cat)
      case "$4" in
        /tmp/lyrashield-worker-egress-drain-request)
          [ -s "$DRAIN_REQUEST_CAPTURE" ] && cat "$DRAIN_REQUEST_CAPTURE"
          ;;
        /tmp/lyrashield-worker-egress-drain-ready)
          if [ "${DOCKER_DRAIN_READY:-0}" = "1" ] && [ -s "$DRAIN_REQUEST_CAPTURE" ]; then
            cat "$DRAIN_REQUEST_CAPTURE"
          else
            exit 1
          fi
          ;;
        *) exit 1 ;;
      esac
      ;;
    sh)
      case "$5" in
        *egress-drain-request*)
          printf '%s\n' "$7" >"$DRAIN_REQUEST_CAPTURE"
          if [ "${BECOME_ACTIVE_ON_DRAIN:-0}" = "1" ]; then
            : >"$ACTIVITY_TRANSITION_CAPTURE"
          fi
          ;;
        *planned-restart*)
          : >"$PLANNED_RESTART_CAPTURE"
          printf '%s\n' "$*" >>"$DOCKER_CAPTURE"
          ;;
        *) exit 1 ;;
      esac
      ;;
    rm)
      rm -f "$DRAIN_REQUEST_CAPTURE" "$PLANNED_RESTART_CAPTURE"
      rm -f "$WORKER_RUNNING_CAPTURE"
      ;;
    *) exit 1 ;;
  esac
  exit
fi
case "$5" in
  *Subnet*)
    if [ "$3" = "bridge" ]; then echo "172.17.0.0/16"; else echo "172.18.0.0/16"; fi
    ;;
  *bridge.name*) echo "docker0" ;;
  *) exit 1 ;;
esac
EOF

cat >"$fake_bin/getent" <<'EOF'
#!/bin/sh
printf '%s\n' "$2" >>"$GETENT_CAPTURE"
if [ "$2" = "proxy.test" ]; then
  echo "8.8.4.4 STREAM proxy.test"
else
  echo "8.8.8.8 STREAM $2"
fi
EOF

cat >"$fake_bin/iptables" <<'EOF'
#!/bin/sh
case "$1" in
  -N|-C) exit 1 ;;
  *) exit 0 ;;
esac
EOF

cat >"$fake_bin/iptables-restore" <<'EOF'
#!/bin/sh
cat >"$IPTABLES_CAPTURE"
[ "${IPTABLES_RESTORE_FAIL:-0}" != "1" ]
EOF

cat >"$fake_bin/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$SYSTEMCTL_CAPTURE"
[ "${SYSTEMCTL_FAIL:-0}" != "1" ]
EOF

cat >"$fake_bin/sleep" <<'EOF'
#!/bin/sh
exit 0
EOF

chmod +x "$fake_bin"/*

environment_file="$test_dir/worker.env"
cat >"$environment_file" <<'EOF'
DATABASE_URL=postgresql://db.test:5432/lyrashield
REDIS_URL=rediss://redis.test:6379
AZURE_AI_API_BASE=https://ai.test
S3_ENDPOINT=https://storage.test
LYRASHIELD_EGRESS_PROXY_URL=https://proxy.test
EOF

pin_file="$test_dir/pins"
printf '%s\n' "proxy.test 9.9.9.9 443" >"$pin_file"
systemctl_capture="$test_dir/systemctl.log"
iptables_capture="$test_dir/iptables.rules"
: >"$systemctl_capture"
: >"$docker_capture"
: >"$getent_capture"
printf '%s\n' running >"$worker_running_capture"

run_refresh() {
  worker_active="$1"
  drain_ready="$2"
  systemctl_fail="$3"
  output_capture="$4"
  error_capture="$5"
  restart_on_change="${6:-1}"
  clear_pending_restart="${7:-0}"
  iptables_restore_fail="${8:-0}"
  PATH="$fake_bin:$PATH" \
  DOCKER_WORKER_ACTIVE="$worker_active" \
  DOCKER_DRAIN_READY="$drain_ready" \
  SYSTEMCTL_FAIL="$systemctl_fail" \
  IPTABLES_RESTORE_FAIL="$iptables_restore_fail" \
  BECOME_ACTIVE_ON_DRAIN="${BECOME_ACTIVE_ON_DRAIN:-0}" \
  SYSTEMCTL_CAPTURE="$systemctl_capture" \
  DOCKER_CAPTURE="$docker_capture" \
  DRAIN_REQUEST_CAPTURE="$drain_request_capture" \
  PLANNED_RESTART_CAPTURE="$planned_restart_capture" \
  WORKER_RUNNING_CAPTURE="$worker_running_capture" \
  ACTIVITY_TRANSITION_CAPTURE="$activity_transition_capture" \
  GETENT_CAPTURE="$getent_capture" \
  IPTABLES_CAPTURE="$iptables_capture" \
  LYRASHIELD_WORKER_ENV_FILE="$environment_file" \
  LYRASHIELD_EGRESS_PIN_FILE="$pin_file" \
  LYRASHIELD_EGRESS_RESTART_PENDING_FILE="$restart_pending_file" \
  LYRASHIELD_REFRESH_PINNED_HOSTS=1 \
  LYRASHIELD_RESTART_WORKER_ON_PIN_CHANGE="$restart_on_change" \
  LYRASHIELD_CLEAR_PENDING_RESTART="$clear_pending_restart" \
  LYRASHIELD_EGRESS_DRAIN_WAIT_ATTEMPTS=1 \
  sh "$repo_root/ops/worker/refresh-egress.sh" >"$output_capture" 2>"$error_capture"
}

first_output="$test_dir/first.out"
second_output="$test_dir/second.out"
idle_output="$test_dir/idle.out"
final_output="$test_dir/final.out"
error_output="$test_dir/error.out"
expected_diagnostic="Worker egress pins changed; hosts: ai.test,api.first.org,api.github.com,api.osv.dev,api.parallel.ai,db.test,github.com,proxy.test,redis.test,storage.test; IP addresses redacted"

printf '%s\n' "sentinel" >"$iptables_capture"
: >"$pin_file"
if run_refresh 1 0 0 "$first_output" "$error_output"; then
  echo "Active refresh accepted a missing old pin set" >&2
  exit 1
fi
grep -Fqx 'sentinel' "$iptables_capture"
grep -Fq 'validated old pins are unavailable' "$error_output"
test -e "$restart_pending_file"
rm -f "$restart_pending_file"

printf '%s\n' "unreviewed.test 8.8.8.8 443" >"$pin_file"
if run_refresh 0 0 0 "$first_output" "$error_output"; then
  echo "Refresh accepted an unreviewed retained endpoint" >&2
  exit 1
fi
grep -Fqx 'sentinel' "$iptables_capture"
grep -Fq 'unapproved host or port' "$error_output"

printf '%s\n' "proxy.test 9.9.9.9 443" >"$pin_file"
: >"$restart_pending_file"
if run_refresh 0 0 0 "$first_output" "$error_output" 0 1 1; then
  echo "Startup refresh ignored an iptables apply failure" >&2
  exit 1
fi
test -e "$restart_pending_file"
run_refresh 0 0 0 "$first_output" "$error_output" 0 1 0
test ! -e "$restart_pending_file"
test ! -s "$systemctl_capture"

printf '%s\n' "proxy.test 9.9.9.9 443" >"$pin_file"
: >"$systemctl_capture"
rm -f "$restart_pending_file" "$drain_request_capture" "$planned_restart_capture"
run_refresh 1 0 0 "$first_output" "$error_output"
test ! -s "$systemctl_capture"
test -e "$restart_pending_file"
test ! -e "$drain_request_capture"
test ! -e "$planned_restart_capture"
grep -q '^proxy.test 9.9.9.9 443$' "$pin_file"
grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT' "$iptables_capture"
grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT' "$iptables_capture"
grep -Fqx 'Worker egress restart deferred; active scan remains healthy' "$first_output"

rm -f "$restart_pending_file" "$drain_request_capture" "$planned_restart_capture"
export BECOME_ACTIVE_ON_DRAIN=1
run_refresh 0 0 0 "$first_output" "$error_output"
unset BECOME_ACTIVE_ON_DRAIN
test ! -s "$systemctl_capture"
test -e "$restart_pending_file"
test -e "$activity_transition_capture"
test -s "$drain_request_capture"
grep -q '^proxy.test 9.9.9.9 443$' "$pin_file"
grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT' "$iptables_capture"
grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT' "$iptables_capture"
grep -Fqx "$expected_diagnostic" "$first_output"
diagnostic=$(grep -F 'Worker egress pins changed; hosts:' "$first_output")
if printf '%s\n' "$diagnostic" | grep -Eq '9\.9\.9\.9|8\.8\.4\.4'; then
  echo "Pin-change diagnostic disclosed an address" >&2
  exit 1
fi

run_refresh 1 0 0 "$second_output" "$error_output"
test ! -s "$systemctl_capture"
test -e "$restart_pending_file"
grep -q '^proxy.test 9.9.9.9 443$' "$pin_file"
grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT' "$iptables_capture"
grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT' "$iptables_capture"
grep -Fqx "$expected_diagnostic" "$second_output"

if run_refresh 0 1 1 "$idle_output" "$error_output"; then
  echo "Refresh ignored a restart scheduling failure" >&2
  exit 1
fi
grep -q '^--no-block try-restart lyrashield-worker.service$' "$systemctl_capture"
test -e "$restart_pending_file"
test ! -e "$drain_request_capture"
test ! -e "$worker_running_capture"
grep -q '^proxy.test 9.9.9.9 443$' "$pin_file"
grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT' "$iptables_capture"
grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT' "$iptables_capture"
grep -Fq 'retained old pins and pending retry' "$error_output"

: >"$systemctl_capture"
printf '%s\n' running >"$worker_running_capture"
run_refresh 0 1 0 "$idle_output" "$error_output"
grep -q '^--no-block try-restart lyrashield-worker.service$' "$systemctl_capture"
grep -q 'sh -c umask 077; : > /tmp/lyrashield-worker-planned-restart' "$docker_capture"
test ! -e "$restart_pending_file"
grep -q '^proxy.test 8.8.4.4 443$' "$pin_file"
grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT' "$iptables_capture"
if grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT' "$iptables_capture"; then
  echo "Idle refresh retained an obsolete address" >&2
  exit 1
fi
grep -Fqx "$expected_diagnostic" "$idle_output"

if grep -Fqx 'www.cisa.gov' "$getent_capture"; then
  echo "CISA remained in the direct worker allowlist" >&2
  exit 1
fi
for required_host in \
  db.test redis.test ai.test storage.test github.com api.github.com api.osv.dev api.first.org proxy.test api.parallel.ai; do
  grep -Fqx "$required_host" "$getent_capture"
done

restart_count=$(wc -l <"$systemctl_capture" | tr -d ' ')
run_refresh 0 0 0 "$final_output" "$error_output"
test "$(wc -l <"$systemctl_capture" | tr -d ' ')" = "$restart_count"
test ! -s "$final_output"

echo "refresh-egress pin-rotation test passed"
