#!/bin/sh
set -eu

environment_file="${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}"
chain_name="LYRASHIELD-EGRESS"
worker_network="${LYRASHIELD_WORKER_NETWORK:-bridge}"
sandbox_network="${LYRASHIELD_SANDBOX_NETWORK:-lyrashield-sandbox}"
pin_file="${LYRASHIELD_EGRESS_PIN_FILE:-/run/lyrashield-egress-hosts}"
refresh_pins="${LYRASHIELD_REFRESH_PINNED_HOSTS:-0}"

if [ ! -r "$environment_file" ]; then
  echo "Worker environment file is unavailable: $environment_file" >&2
  exit 1
fi

read_environment_value() {
  environment_name="$1"
  environment_value=$(sed -n "s/^${environment_name}=//p" "$environment_file")
  if [ -z "$environment_value" ]; then
    echo "Required worker environment value is missing: $environment_name" >&2
    exit 1
  fi
  printf '%s' "$environment_value"
}

DATABASE_URL=$(read_environment_value DATABASE_URL)
REDIS_URL=$(read_environment_value REDIS_URL)
AZURE_AI_API_BASE=$(read_environment_value AZURE_AI_API_BASE)
S3_ENDPOINT=$(read_environment_value S3_ENDPOINT)
LYRASHIELD_EGRESS_PROXY_URL=$(read_environment_value LYRASHIELD_EGRESS_PROXY_URL)

worker_subnet=$(docker network inspect "$worker_network" --format '{{(index .IPAM.Config 0).Subnet}}')
worker_bridge=$(docker network inspect "$worker_network" --format '{{index .Options "com.docker.network.bridge.name"}}')
sandbox_subnet=$(docker network inspect "$sandbox_network" --format '{{(index .IPAM.Config 0).Subnet}}')

if [ -z "$worker_bridge" ] && [ "$worker_network" = "bridge" ]; then
  worker_bridge="docker0"
fi
if [ -z "$worker_subnet" ] || [ -z "$worker_bridge" ] || [ -z "$sandbox_subnet" ]; then
  echo "Could not resolve the worker and sandbox Docker network boundaries" >&2
  exit 1
fi

pin_dir=$(dirname "$pin_file")
temporary_rules=$(mktemp "${pin_dir}/lyrashield-egress-rules.XXXXXX")
temporary_pins=$(mktemp "${pin_file}.XXXXXX")
temporary_old_pins=$(mktemp "${pin_file}.old.XXXXXX")
temporary_approved_endpoints=$(mktemp "${pin_file}.approved.XXXXXX")
temporary_union_rules=$(mktemp "${pin_dir}/lyrashield-egress-union.XXXXXX")
trap 'rm -f "$temporary_rules" "$temporary_pins" "$temporary_old_pins" "$temporary_approved_endpoints" "$temporary_union_rules"' EXIT HUP INT TERM

if [ ! -s "$pin_file" ]; then
  refresh_pins=1
fi

validate_approved_host_port() {
  host="$1"
  port="$2"

  case "$host" in
    '' | *[!A-Za-z0-9.-]*)
      echo "Invalid endpoint host in worker egress pin" >&2
      exit 1
      ;;
  esac
  case "$port" in
    '' | *[!0-9]*)
      echo "Invalid endpoint port in worker egress pin" >&2
      exit 1
      ;;
  esac
}

validate_approved_ip_tuple() {
  host="$1"
  address="$2"
  port="$3"

  validate_approved_host_port "$host" "$port"
  case "$address" in
    '' | *[!0-9.]* | 0.* | 10.* | 100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].* | 127.* | 169.254.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 192.0.0.* | 192.0.2.* | 192.88.99.* | 192.168.* | 198.1[89].* | 198.51.100.* | 203.0.113.* | 22[4-9].* | 23[0-9].* | 24[0-9].* | 25[0-5].*)
      echo "Approved endpoint resolved to a non-public IPv4 address: $host" >&2
      exit 1
      ;;
  esac
}

append_approved_ip_rule() {
  host="$1"
  address="$2"
  port="$3"
  destination_file="${4:-$temporary_rules}"

  validate_approved_ip_tuple "$host" "$address" "$port"

  printf '%s\n' "-A $chain_name -p tcp -d $address --dport $port -j ACCEPT" >>"$destination_file"
}

load_approved_pin_file() {
  source_file="$1"
  destination_file="$2"

  if [ ! -e "$source_file" ]; then
    return
  fi
  while read -r pinned_host pinned_address pinned_port extra; do
    if [ -n "${extra:-}" ]; then
      echo "Invalid worker egress pin entry" >&2
      exit 1
    fi
    validate_approved_ip_tuple "$pinned_host" "$pinned_address" "$pinned_port"
    if ! grep -Fqx "$pinned_host $pinned_port" "$temporary_approved_endpoints"; then
      echo "Worker egress pin contains an unapproved host or port" >&2
      exit 1
    fi
    printf '%s %s %s\n' "$pinned_host" "$pinned_address" "$pinned_port" >>"$destination_file"
  done <"$source_file"
}

parse_endpoint() {
  endpoint="$1"
  default_port="$2"
  authority=${endpoint#*://}
  authority=${authority%%/*}
  authority=${authority##*@}
  endpoint_host=${authority%%:*}
  endpoint_port=${authority##*:}
  if [ "$endpoint_port" = "$authority" ]; then
    endpoint_port="$default_port"
  fi

  validate_approved_host_port "$endpoint_host" "$endpoint_port"
}

register_approved_endpoint() {
  parse_endpoint "$1" "$2"
  printf '%s %s\n' "$endpoint_host" "$endpoint_port" >>"$temporary_approved_endpoints"
}

append_endpoint_rules() {
  parse_endpoint "$1" "$2"
  host="$endpoint_host"
  port="$endpoint_port"

  addresses=$(getent ahostsv4 "$host" | awk '{print $1}' | sort -u)
  if [ -z "$addresses" ]; then
    echo "Could not resolve approved worker endpoint: $host" >&2
    exit 1
  fi
  for address in $addresses; do
    append_approved_ip_rule "$host" "$address" "$port"
    if [ "$refresh_pins" = "1" ]; then
      printf '%s %s %s\n' "$host" "$address" "$port" >>"$temporary_pins"
    fi
  done
}

cat >"$temporary_rules" <<EOF
*filter
:${chain_name} - [0:0]
-F ${chain_name}
-A ${chain_name} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A ${chain_name} -d ${sandbox_subnet} -j ACCEPT
-A ${chain_name} -p udp -d 168.63.129.16 --dport 53 -j ACCEPT
-A ${chain_name} -p tcp -d 168.63.129.16 --dport 53 -j ACCEPT
-A ${chain_name} -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 192.0.0.0/24 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 192.0.2.0/24 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 192.88.99.0/24 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 198.18.0.0/15 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 198.51.100.0/24 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 203.0.113.0/24 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A ${chain_name} -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
EOF

register_approved_endpoint "$DATABASE_URL" 5432
register_approved_endpoint "$REDIS_URL" 6379
register_approved_endpoint "$AZURE_AI_API_BASE" 443
register_approved_endpoint "$S3_ENDPOINT" 443
register_approved_endpoint "https://github.com" 443
register_approved_endpoint "https://api.github.com" 443
register_approved_endpoint "https://api.osv.dev" 443
register_approved_endpoint "https://api.first.org" 443
register_approved_endpoint "$LYRASHIELD_EGRESS_PROXY_URL" 443
register_approved_endpoint "https://api.parallel.ai" 443
# Staged rollout only: an already-running pre-proxy worker may still depend on
# its old CISA hosts entry until the drain handshake completes.
register_approved_endpoint "https://www.cisa.gov" 443
LC_ALL=C sort -u "$temporary_approved_endpoints" -o "$temporary_approved_endpoints"

load_approved_pin_file "$pin_file" "$temporary_old_pins"
LC_ALL=C sort -u "$temporary_old_pins" -o "$temporary_old_pins"

if [ "$refresh_pins" != "1" ]; then
  while read -r pinned_host pinned_address pinned_port; do
    append_approved_ip_rule "$pinned_host" "$pinned_address" "$pinned_port"
  done <"$temporary_old_pins"
fi

append_endpoint_rules "$DATABASE_URL" 5432
append_endpoint_rules "$REDIS_URL" 6379
append_endpoint_rules "$AZURE_AI_API_BASE" 443
append_endpoint_rules "$S3_ENDPOINT" 443
append_endpoint_rules "https://github.com" 443
append_endpoint_rules "https://api.github.com" 443
append_endpoint_rules "https://api.osv.dev" 443
append_endpoint_rules "https://api.first.org" 443
append_endpoint_rules "$LYRASHIELD_EGRESS_PROXY_URL" 443
append_endpoint_rules "https://api.parallel.ai" 443

pins_changed=0
worker_running=0
if [ "$refresh_pins" = "1" ]; then
  LC_ALL=C sort -u "$temporary_pins" -o "$temporary_pins"
  if ! cmp -s "$temporary_old_pins" "$temporary_pins"; then
    pins_changed=1
    changed_hosts=$(
      awk '
        FILENAME == ARGV[1] { old[$0] = 1; next }
        { new[$0] = 1 }
        END {
          for (line in old) {
            if (!(line in new)) {
              split(line, fields, " ")
              changed[fields[1]] = 1
            }
          }
          for (line in new) {
            if (!(line in old)) {
              split(line, fields, " ")
              changed[fields[1]] = 1
            }
          }
          for (host in changed) print host
        }
      ' "$temporary_old_pins" "$temporary_pins" | LC_ALL=C sort | paste -sd, -
    )
  fi
fi

cat >>"$temporary_rules" <<EOF
-A ${chain_name} -j REJECT --reject-with icmp-admin-prohibited
COMMIT
EOF

apply_firewall_rules() {
  rules_file="$1"
  iptables -N "$chain_name" 2>/dev/null || true
  iptables-restore --noflush <"$rules_file" || return 1
  if ! iptables -C DOCKER-USER -i "$worker_bridge" -s "$worker_subnet" -j "$chain_name" 2>/dev/null; then
    iptables -I DOCKER-USER 1 -i "$worker_bridge" -s "$worker_subnet" -j "$chain_name"
  fi
}

worker_hosts_prefix="/tmp/lyrashield-egress-hosts.$$"
worker_hosts_pins="${worker_hosts_prefix}.pins"
worker_hosts_approved="${worker_hosts_prefix}.approved"
worker_hosts_backup="${worker_hosts_prefix}.backup"
worker_hosts_next="${worker_hosts_prefix}.next"

copy_worker_file() {
  source_file="$1"
  destination_file="$2"
  docker exec --user 0:0 -i lyrashield-worker sh -c \
    'umask 077; cat > "$1"' sh "$destination_file" <"$source_file"
}

cleanup_worker_host_files() {
  docker exec --user 0:0 lyrashield-worker rm -f \
    "$worker_hosts_pins" "$worker_hosts_approved" "$worker_hosts_backup" "$worker_hosts_next" \
    >/dev/null 2>&1 || true
}

restore_worker_hosts() {
  docker exec --user 0:0 lyrashield-worker sh -c \
    'test -s "$1" && cat "$1" > /etc/hosts' sh "$worker_hosts_backup" \
    >/dev/null 2>&1
}

update_and_verify_worker_hosts() {
  copy_worker_file "$temporary_pins" "$worker_hosts_pins" || return 1
  copy_worker_file "$temporary_approved_endpoints" "$worker_hosts_approved" || return 1

  if ! docker exec --user 0:0 lyrashield-worker sh -c '
    set -eu
    pins=$1
    approved=$2
    backup=$3
    next=$4
    cp /etc/hosts "$backup"
    awk '\''
      NR == FNR { approved[$1] = 1; next }
      {
        keep = 1
        for (field = 2; field <= NF; field++) {
          if ($field in approved) keep = 0
        }
        if (keep) print
      }
    '\'' "$approved" /etc/hosts >"$next"
    awk '\''{ print $2 " " $1 }'\'' "$pins" >>"$next"
    test -s "$next"
    cat "$next" > /etc/hosts
  ' sh "$worker_hosts_pins" "$worker_hosts_approved" "$worker_hosts_backup" "$worker_hosts_next"; then
    restore_worker_hosts || true
    return 1
  fi

  if ! docker exec --user 0:0 lyrashield-worker sh -c '
    set -eu
    pins=$1
    approved=$2
    while read -r host; do
      expected=$(awk -v host="$host" '\''$1 == host { print $2 }'\'' "$pins" | LC_ALL=C sort -u)
      actual=$(getent ahostsv4 "$host" | awk '\''{ print $1 }'\'' | LC_ALL=C sort -u)
      [ -n "$expected" ] && [ "$actual" = "$expected" ]
    done <<EOF
$(awk '\''{ print $1 }'\'' "$pins" | LC_ALL=C sort -u)
EOF
    while read -r host _port; do
      if ! awk -v host="$host" '\''$1 == host { found = 1 } END { exit !found }'\'' "$pins"; then
        if awk -v host="$host" '\''
          {
            for (field = 2; field <= NF; field++) {
              if ($field == host) found = 1
            }
          }
          END { exit !found }
        '\'' /etc/hosts; then
          exit 1
        fi
      fi
    done <"$approved"
  ' sh "$worker_hosts_pins" "$worker_hosts_approved"; then
    restore_worker_hosts || true
    return 1
  fi
}

if [ "$pins_changed" = "1" ] && docker exec lyrashield-worker true 2>/dev/null; then
  worker_running=1
  if [ ! -s "$temporary_old_pins" ]; then
    echo "Cannot refresh running worker egress without validated old pins" >&2
    exit 1
  fi

  cp "$temporary_rules" "$temporary_union_rules"
  # Remove final deny/commit, append old pins, then restore final deny. Existing
  # connections remain allowed by ESTABLISHED while both pin sets are accepted.
  sed -i.bak '/^-A LYRASHIELD-EGRESS -j REJECT --reject-with icmp-admin-prohibited$/d; /^COMMIT$/d' "$temporary_union_rules"
  rm -f "${temporary_union_rules}.bak"
  while read -r pinned_host pinned_address pinned_port; do
    append_approved_ip_rule "$pinned_host" "$pinned_address" "$pinned_port" \
      "$temporary_union_rules"
  done <"$temporary_old_pins"
  cat >>"$temporary_union_rules" <<EOF
-A ${chain_name} -j REJECT --reject-with icmp-admin-prohibited
COMMIT
EOF

  apply_firewall_rules "$temporary_union_rules"
  if ! update_and_verify_worker_hosts; then
    cleanup_worker_host_files
    echo "Running worker hosts refresh failed; retained old pins and old/new firewall union" >&2
    exit 1
  fi
fi

if [ "$pins_changed" = "1" ]; then
  chmod 600 "$temporary_pins"
  mv -f "$temporary_pins" "$pin_file"
fi

if ! apply_firewall_rules "$temporary_rules"; then
  if [ "$pins_changed" = "1" ]; then
    chmod 600 "$temporary_old_pins"
    mv -f "$temporary_old_pins" "$pin_file"
  fi
  if [ "$worker_running" = "1" ]; then
    apply_firewall_rules "$temporary_union_rules" || true
    restore_worker_hosts || true
    cleanup_worker_host_files
  fi
  echo "Worker egress firewall refresh failed; retained old pins and old/new firewall union" >&2
  exit 1
fi

cleanup_worker_host_files
if [ "$pins_changed" = "1" ]; then
  echo "Worker egress pins changed; hosts: $changed_hosts; IP addresses redacted"
fi
