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

run_refresh() {
  worker_active="$1"
  PATH="$fake_bin:$PATH" \
  DOCKER_WORKER_ACTIVE="$worker_active" \
  SYSTEMCTL_CAPTURE="$systemctl_capture" \
  DOCKER_CAPTURE="$docker_capture" \
  IPTABLES_CAPTURE="$iptables_capture" \
  LYRASHIELD_WORKER_ENV_FILE="$environment_file" \
  LYRASHIELD_EGRESS_PIN_FILE="$pin_file" \
  LYRASHIELD_EGRESS_RESTART_PENDING_FILE="$restart_pending_file" \
  LYRASHIELD_REFRESH_PINNED_HOSTS=1 \
  LYRASHIELD_RESTART_WORKER_ON_PIN_CHANGE=1 \
  sh "$repo_root/ops/worker/refresh-egress.sh"
}

run_refresh 1
test ! -s "$systemctl_capture"
test -e "$restart_pending_file"
grep -q '^proxy.test 8.8.4.4 443$' "$pin_file"
grep -q -- '-d 8.8.4.4 --dport 443 -j ACCEPT' "$iptables_capture"

run_refresh 0
grep -q '^--no-block try-restart lyrashield-worker.service$' "$systemctl_capture"
grep -q 'sh -c umask 077; : > /tmp/lyrashield-worker-planned-restart' "$docker_capture"
test ! -e "$restart_pending_file"

restart_count=$(wc -l <"$systemctl_capture" | tr -d ' ')
run_refresh 0
test "$(wc -l <"$systemctl_capture" | tr -d ' ')" = "$restart_count"

echo "refresh-egress pin-rotation test passed"
