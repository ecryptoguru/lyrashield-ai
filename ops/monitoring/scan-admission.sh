#!/bin/sh
set -eu

key="lyrashield:scan-admission:stopped"
command_name="${1:-}"
: "${REDIS_URL:?REDIS_URL is required}"

case "$command_name" in
  stop)
    operator="${2:-}"
    reason="${3:-}"
    if [ -z "$operator" ] || [ -z "$reason" ]; then
      echo "Usage: $0 stop OPERATOR REASON" >&2
      exit 2
    fi
    payload=$(node -e 'process.stdout.write(JSON.stringify({operator:process.argv[1],reason:process.argv[2],stoppedAt:new Date().toISOString()}))' "$operator" "$reason")
    redis-cli --no-auth-warning -u "$REDIS_URL" SET "$key" "$payload" >/dev/null
    echo "Scan admission stopped by $operator"
    ;;
  resume)
    operator="${2:-}"
    if [ -z "$operator" ]; then
      echo "Usage: $0 resume OPERATOR" >&2
      exit 2
    fi
    redis-cli --no-auth-warning -u "$REDIS_URL" DEL "$key" >/dev/null
    echo "Scan admission resumed by $operator"
    ;;
  status)
    value=$(redis-cli --no-auth-warning --raw -u "$REDIS_URL" GET "$key")
    if [ -n "$value" ]; then
      echo "$value"
      exit 1
    fi
    echo "Scan admission active"
    ;;
  *)
    echo "Usage: $0 stop OPERATOR REASON | resume OPERATOR | status" >&2
    exit 2
    ;;
esac
