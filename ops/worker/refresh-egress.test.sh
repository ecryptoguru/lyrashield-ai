#!/bin/sh
set -eu

CDPATH=
export CDPATH
repo_root=$(cd -- "$(dirname "$0")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
fake_bin="$test_dir/bin"
restart_pending_file="$test_dir/restart-pending"
docker_capture="$test_dir/docker.log"
getent_capture="$test_dir/getent.log"
mkdir -p "$fake_bin"

cat >"$fake_bin/docker" <<'EOF'
#!/bin/sh
if [ "$1" = "exec" ]; then
  if [ "$3" = "test" ]; then
    [ "${DOCKER_WORKER_ACTIVE:-0}" = "1" ]
    exit
  fi
  printf '%s\n' "$*" >>"$DOCKER_CAPTURE"
  exit 0
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
EOF

cat >"$fake_bin/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$SYSTEMCTL_CAPTURE"
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

run_refresh() {
  worker_active="$1"
  output_capture="$2"
  PATH="$fake_bin:$PATH" \
  DOCKER_WORKER_ACTIVE="$worker_active" \
  SYSTEMCTL_CAPTURE="$systemctl_capture" \
  DOCKER_CAPTURE="$docker_capture" \
  GETENT_CAPTURE="$getent_capture" \
  IPTABLES_CAPTURE="$iptables_capture" \
  LYRASHIELD_WORKER_ENV_FILE="$environment_file" \
  LYRASHIELD_EGRESS_PIN_FILE="$pin_file" \
  LYRASHIELD_EGRESS_RESTART_PENDING_FILE="$restart_pending_file" \
  LYRASHIELD_REFRESH_PINNED_HOSTS=1 \
  LYRASHIELD_RESTART_WORKER_ON_PIN_CHANGE=1 \
  sh "$repo_root/ops/worker/refresh-egress.sh" >"$output_capture"
}

first_output="$test_dir/first.out"
second_output="$test_dir/second.out"
idle_output="$test_dir/idle.out"
final_output="$test_dir/final.out"
expected_diagnostic="Worker egress pins changed; hosts: ai.test,api.first.org,api.github.com,api.osv.dev,api.parallel.ai,db.test,github.com,proxy.test,redis.test,storage.test; IP addresses redacted"

run_refresh 1 "$first_output"
test ! -s "$systemctl_capture"
test -e "$restart_pending_file"
grep -q '^proxy.test 9.9.9.9 443$' "$pin_file"
grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT' "$iptables_capture"
grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT' "$iptables_capture"
grep -Fqx "$expected_diagnostic" "$first_output"
diagnostic=$(grep -F 'Worker egress pins changed; hosts:' "$first_output")
if printf '%s\n' "$diagnostic" | grep -Eq '9\.9\.9\.9|8\.8\.4\.4'; then
  echo "Pin-change diagnostic disclosed an address" >&2
  exit 1
fi

run_refresh 1 "$second_output"
test ! -s "$systemctl_capture"
test -e "$restart_pending_file"
grep -q '^proxy.test 9.9.9.9 443$' "$pin_file"
grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT' "$iptables_capture"
grep -q -- '-d 9.9.9.9 --dport 443 -j ACCEPT' "$iptables_capture"
grep -Fqx "$expected_diagnostic" "$second_output"

run_refresh 0 "$idle_output"
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
run_refresh 0 "$final_output"
test "$(wc -l <"$systemctl_capture" | tr -d ' ')" = "$restart_count"
test ! -s "$final_output"

echo "refresh-egress pin-rotation test passed"
