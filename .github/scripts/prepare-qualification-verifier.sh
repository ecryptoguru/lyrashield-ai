#!/usr/bin/env bash
# Future protected CI provisioning only; never run on a production host.
set -euo pipefail
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || exit 1
[[ -n "${RUNNER_TEMP:-}" && -d "$RUNNER_TEMP" && ! -L /usr/bin/gh ]] || exit 1
qualification_tools=$(mktemp -d "$RUNNER_TEMP/qualification-gh.XXXXXXXX")
trap 'rm -rf "$qualification_tools"' EXIT
archive="$qualification_tools/gh.tar.gz"
curl --proto '=https' --tlsv1.2 --fail --location --retry 2 --connect-timeout 20 --max-time 180 \
  https://github.com/cli/cli/releases/download/v2.95.0/gh_2.95.0_linux_amd64.tar.gz --output "$archive"
printf '%s  %s\n' 25d1e4729e8808c9ed3d613e96ebd3f3e44446f2d368c89d878a71a36ddb3d8c "$archive" | sha256sum --check --status
tar -xzf "$archive" -C "$qualification_tools" gh_2.95.0_linux_amd64/bin/gh
binary="$qualification_tools/gh_2.95.0_linux_amd64/bin/gh"
[[ -f "$binary" && ! -L "$binary" ]] || exit 1
printf '%s  %s\n' 62c11fbaa08835168c3d1acf8a645ac6268a13a5682c73581388c9df0c622617 "$binary" | sha256sum --check --status
sudo install -o root -g root -m 0755 "$binary" /usr/bin/gh
[[ "$(stat -c %u /usr/bin/gh)" == 0 ]] || exit 1
printf '%s  %s\n' 62c11fbaa08835168c3d1acf8a645ac6268a13a5682c73581388c9df0c622617 /usr/bin/gh | sha256sum --check --status
