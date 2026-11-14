#!/bin/bash
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

[[ $# = 1 && $1 =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ $(uname -s) = Linux && $(id -u) = 0 ]] || exit 2
source_revision=$1
repository=$(git --no-replace-objects -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
[[ $(git --no-replace-objects -C "$repository" rev-parse HEAD) = "$source_revision" ]] || exit 2
git --no-replace-objects -C "$repository" merge-base --is-ancestor "$source_revision" refs/remotes/origin/main

for command in install flock getent groupadd systemctl prlimit; do
  command -v "$command" >/dev/null
done
[[ -x /usr/bin/python3 ]]

# Install exact committed blobs rather than a mutable checkout overlay.
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
assets=(
  ops/controller/authority-observer.py
  .github/scripts/paired-runtime-host-observation.py
  ops/controller/lyrashield-authority-observer.socket
  ops/controller/lyrashield-authority-observer.service
  ops/controller/lyrashield-broker-authority-observer.socket
  ops/controller/lyrashield-broker-authority-observer.service
  ops/controller/native-executor.py
  ops/controller/native-executor-tool.py
  ops/controller/native-executor-pty.py
  ops/controller/native-engine-result.py
  ops/controller/disposable-native-authority.py
  ops/controller/disposable-observation.py
  ops/controller/worker-observation.py
  ops/controller/lyrashield-worker-authority-observer.socket
  ops/controller/lyrashield-worker-authority-observer.service
  ops/controller/preparation-issuer.py
  ops/controller/preparation-acquisition-host.py
  ops/controller/source-tree.py
  ops/controller/lyrashield-preparation-issuer.socket
  ops/controller/lyrashield-preparation-issuer.service
  ops/controller/lyrashield-native-executor.socket
  ops/controller/lyrashield-native-executor.service
)
for asset in "${assets[@]}"; do
  git -C "$repository" --no-replace-objects show "$source_revision:$asset" > "$staging/$(basename "$asset")"
done

/usr/bin/python3 -I - "$staging/paired-runtime-host-observation.py" <<'PY'
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path

for name in ("/run", "/opt", "/etc", "/etc/systemd", "/etc/systemd/system", "/var", "/var/lib"):
    info = Path(name).lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit("Protected controller installation parent unavailable")
for name in ("/run/lyrashield", "/run/lyrashield/control", "/opt/lyrashield", "/opt/lyrashield/runtime-control", "/var/lib/lyrashield", "/etc/lyrashield", "/etc/lyrashield/control"):
    path = Path(name)
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=0o755)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit("Protected controller installation directory unavailable")
for name in ("/var/lib/lyrashield/native-executor", "/var/lib/lyrashield/preparation", "/var/lib/lyrashield/control", "/var/lib/lyrashield/control/inputs", "/etc/lyrashield/control/resources"):
    path = Path(name)
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise SystemExit("Protected controller private directory unavailable")
pin = Path("/opt/lyrashield/runtime-control/runtime-qualification-key.json")
info = pin.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > 16384:
    raise SystemExit("Protected managed qualification pin unavailable")
spec = importlib.util.spec_from_file_location("installed_observer_validation", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.public_der(json.loads(pin.read_bytes()))
lock = Path("/run/lyrashield/controller-install.lock")
fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
        raise SystemExit("Protected controller installation lock unavailable")
finally:
    os.close(fd)
PY

exec 9>/run/lyrashield/controller-install.lock
flock -n 9
units=(
  lyrashield-authority-observer.service
  lyrashield-authority-observer.socket
  lyrashield-broker-authority-observer.service
  lyrashield-broker-authority-observer.socket
  lyrashield-worker-authority-observer.service
  lyrashield-worker-authority-observer.socket
  lyrashield-native-executor.service
  lyrashield-native-executor.socket
  lyrashield-preparation-issuer.service
  lyrashield-preparation-issuer.socket
)
for unit in "${units[@]}"; do
  if systemctl is-active --quiet "$unit"; then
    printf '%s\n' 'Active controller host units must be drained before replacement.' >&2
    exit 1
  fi
done
for group in lyrashield-supervisor lyrashield-broker lyrashield-worker; do
  if ! getent group "$group" >/dev/null; then
    groupadd --system "$group"
  fi
done
/usr/bin/python3 -I - <<'PY'
import grp
groups = [grp.getgrnam(name) for name in ("lyrashield-supervisor", "lyrashield-broker", "lyrashield-worker")]
if any(group.gr_gid <= 0 or group.gr_mem for group in groups) or len({group.gr_gid for group in groups}) != len(groups):
    raise SystemExit("Authority sockets require distinct nonzero primary role identities")
PY

for file in authority-observer.py paired-runtime-host-observation.py native-executor.py native-executor-tool.py native-executor-pty.py native-engine-result.py disposable-native-authority.py disposable-observation.py worker-observation.py preparation-issuer.py preparation-acquisition-host.py source-tree.py; do
  destination="/opt/lyrashield/runtime-control/$file"
  [[ ! -L "$destination" ]]
  temporary=$(mktemp "$destination.XXXXXX")
  install -o root -g root -m 0755 "$staging/$file" "$temporary"
  mv -Tf "$temporary" "$destination"
done
for file in "${units[@]}"; do
  destination="/etc/systemd/system/$file"
  [[ ! -L "$destination" ]]
  temporary=$(mktemp "$destination.XXXXXX")
  install -o root -g root -m 0644 "$staging/$file" "$temporary"
  mv -Tf "$temporary" "$destination"
done
systemctl daemon-reload
systemctl enable --now lyrashield-authority-observer.socket
systemctl enable --now lyrashield-broker-authority-observer.socket
systemctl enable --now lyrashield-worker-authority-observer.socket
systemctl enable --now lyrashield-native-executor.socket
systemctl enable --now lyrashield-preparation-issuer.socket
systemctl is-active --quiet lyrashield-authority-observer.socket
systemctl is-active --quiet lyrashield-broker-authority-observer.socket
systemctl is-active --quiet lyrashield-worker-authority-observer.socket
systemctl is-active --quiet lyrashield-native-executor.socket
systemctl is-active --quiet lyrashield-preparation-issuer.socket
printf '%s\n' 'Protected controller host sockets installed; runtime authority remains independently verified.'
