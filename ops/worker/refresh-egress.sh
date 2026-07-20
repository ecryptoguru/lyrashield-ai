#!/bin/sh
set -eu

environment_file="${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}"
chain_name="LYRASHIELD-EGRESS"
worker_network="${LYRASHIELD_WORKER_NETWORK:-bridge}"
sandbox_network="${LYRASHIELD_SANDBOX_NETWORK:-lyrashield-sandbox}"

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

temporary_rules=$(mktemp /run/lyrashield-egress.XXXXXX)
trap 'rm -f "$temporary_rules"' EXIT HUP INT TERM

append_endpoint_rules() {
  endpoint="$1"
  default_port="$2"
  authority=${endpoint#*://}
  authority=${authority%%/*}
  authority=${authority##*@}
  host=${authority%%:*}
  port=${authority##*:}
  if [ "$port" = "$authority" ]; then
    port="$default_port"
  fi

  case "$host" in
    '' | *[!A-Za-z0-9.-]*)
      echo "Invalid endpoint host in worker configuration" >&2
      exit 1
      ;;
  esac
  case "$port" in
    '' | *[!0-9]*)
      echo "Invalid endpoint port in worker configuration" >&2
      exit 1
      ;;
  esac

  addresses=$(getent ahostsv4 "$host" | awk '{print $1}' | sort -u)
  if [ -z "$addresses" ]; then
    echo "Could not resolve approved worker endpoint: $host" >&2
    exit 1
  fi
  for address in $addresses; do
    case "$address" in
      0.* | 10.* | 100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].* | 127.* | 169.254.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 192.0.0.* | 192.0.2.* | 192.88.99.* | 192.168.* | 198.1[89].* | 198.51.100.* | 203.0.113.* | 2[2-5][0-9].*)
        echo "Approved endpoint resolved to a non-public address: $host" >&2
        exit 1
        ;;
    esac
    printf '%s\n' "-A $chain_name -p tcp -d $address --dport $port -j ACCEPT" >>"$temporary_rules"
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

append_endpoint_rules "$DATABASE_URL" 5432
append_endpoint_rules "$REDIS_URL" 6379
append_endpoint_rules "$AZURE_AI_API_BASE" 443
append_endpoint_rules "$S3_ENDPOINT" 443
append_endpoint_rules "https://github.com" 443
append_endpoint_rules "https://api.github.com" 443
append_endpoint_rules "https://api.osv.dev" 443
append_endpoint_rules "https://www.cisa.gov" 443
append_endpoint_rules "https://api.first.org" 443

cat >>"$temporary_rules" <<EOF
-A ${chain_name} -j REJECT --reject-with icmp-admin-prohibited
COMMIT
EOF

iptables -N "$chain_name" 2>/dev/null || true
iptables-restore --noflush <"$temporary_rules"
if ! iptables -C DOCKER-USER -i "$worker_bridge" -s "$worker_subnet" -j "$chain_name" 2>/dev/null; then
  iptables -I DOCKER-USER 1 -i "$worker_bridge" -s "$worker_subnet" -j "$chain_name"
fi
