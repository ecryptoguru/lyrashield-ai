#!/bin/sh
set -eu

test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

state_file="$test_dir/state"
cat >"$test_dir/redis-cli" <<'EOF'
#!/bin/sh
set -eu
state_file=${FAKE_REDIS_STATE:?}
command_name=""
for argument in "$@"; do
  case "$argument" in SET|DEL|GET) command_name="$argument"; break ;; esac
done
case "$command_name" in
  SET) printf '%s' "${FAKE_REDIS_PAYLOAD:-stopped}" >"$state_file" ;;
  DEL) rm -f "$state_file" ;;
  GET) test ! -f "$state_file" || cat "$state_file" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$test_dir/redis-cli"

export PATH="$test_dir:$PATH"
export FAKE_REDIS_STATE="$state_file"
export REDIS_URL="rediss://monitoring.test:6379"

sh ops/monitoring/scan-admission.sh stop on-call queue_uncertain >/dev/null
test -f "$state_file"
if sh ops/monitoring/scan-admission.sh status >/dev/null; then
  echo "status must be non-zero while admission is stopped" >&2
  exit 1
fi
sh ops/monitoring/scan-admission.sh resume on-call >/dev/null
test ! -f "$state_file"
test "$(sh ops/monitoring/scan-admission.sh status)" = "Scan admission active"
