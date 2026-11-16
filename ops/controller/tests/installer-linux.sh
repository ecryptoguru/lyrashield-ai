#!/usr/bin/env bash
set -euo pipefail
revision=$1
scenario=$2
git config --global --add safe.directory /work
mkdir -p /opt/lyrashield/runtime-control /etc/systemd/system /tmp/mock-bin
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /tmp/fixture-key.pem 2>/dev/null
openssl rsa -in /tmp/fixture-key.pem -noout -modulus 2>/dev/null > /tmp/modulus
python3 - <<'PY'
import base64, json, pathlib
n = bytes.fromhex(pathlib.Path('/tmp/modulus').read_text().strip().split('=')[1])
pin = {'keyId': 'installer-fixture-only', 'algorithm': 'RS256', 'publicKey': {'kty': 'RSA', 'n': base64.urlsafe_b64encode(n).decode().rstrip('='), 'e': 'AQAB'}}
pathlib.Path('/opt/lyrashield/runtime-control/runtime-qualification-key.json').write_text(json.dumps(pin))
PY
chmod 644 /opt/lyrashield/runtime-control/runtime-qualification-key.json
cat > /tmp/mock-bin/systemctl <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> /tmp/systemctl-log
case "$1" in
  is-active)
    if [ "$3" = lyrashield-authority-observer.service ]; then
      [ "$SCENARIO" = active ]
    else
      [ "$SCENARIO" = active-socket ] || [ -f /tmp/socket-enabled ]
    fi ;;
  enable) touch /tmp/socket-enabled ;;
  daemon-reload) : ;;
  *) exit 1 ;;
esac
SH
chmod 755 /tmp/mock-bin/systemctl
install -o root -g root -m 0755 /tmp/mock-bin/systemctl /usr/bin/systemctl
export SCENARIO="$scenario"
case "$scenario" in
  writable) chmod 777 /opt/lyrashield/runtime-control ;;
  symlink) mv /opt/lyrashield/runtime-control/runtime-qualification-key.json /tmp/pin; ln -s /tmp/pin /opt/lyrashield/runtime-control/runtime-qualification-key.json ;;
  writable-ledger) mkdir -p /var/lib/lyrashield/native-executor; chmod 777 /var/lib/lyrashield/native-executor ;;
  symlink-ledger) mkdir -p /var/lib/lyrashield; ln -s /tmp /var/lib/lyrashield/native-executor ;;
  missing) rm /opt/lyrashield/runtime-control/runtime-qualification-key.json ;;
esac
set +e
bash /work/ops/controller/install-controller-host.sh "$revision" > /tmp/installer-output 2>&1
result=$?
set -e
if [ "$scenario" != success ]; then
  test "$result" -ne 0
  test ! -e /opt/lyrashield/runtime-control/authority-observer.py
  test ! -e /etc/systemd/system/lyrashield-authority-observer.socket
  test ! -e /tmp/socket-enabled
  exit 0
fi
test "$result" -eq 0
for file in authority-observer.py paired-runtime-host-observation.py native-executor.py native-executor-tool.py native-executor-pty.py native-engine-result.py disposable-native-authority.py disposable-observation.py worker-observation.py preparation-issuer.py preparation-acquisition-host.py source-tree.py; do
  test "$(stat -c '%u:%g:%a' "/opt/lyrashield/runtime-control/$file")" = 0:0:755
done
git -C /work show "$revision:ops/controller/authority-observer.py" | cmp - /opt/lyrashield/runtime-control/authority-observer.py
git -C /work show "$revision:.github/scripts/paired-runtime-host-observation.py" | cmp - /opt/lyrashield/runtime-control/paired-runtime-host-observation.py
test "$(stat -c '%u:%g:%a' /etc/systemd/system/lyrashield-authority-observer.socket)" = 0:0:644
test "$(stat -c '%u:%g:%a' /var/lib/lyrashield/native-executor)" = 0:0:700
test ! -e /etc/lyrashield/native-executor.env
for file in native-executor.py native-executor-tool.py native-executor-pty.py native-engine-result.py disposable-native-authority.py disposable-observation.py worker-observation.py preparation-issuer.py preparation-acquisition-host.py source-tree.py; do
  git -C /work show "$revision:ops/controller/$file" | cmp - "/opt/lyrashield/runtime-control/$file"
done
printf '[Service]\nExecStart=/bin/true\n' > /etc/systemd/system/docker.service
systemd-analyze verify /etc/systemd/system/lyrashield-authority-observer.socket /etc/systemd/system/lyrashield-authority-observer.service /etc/systemd/system/lyrashield-broker-authority-observer.socket /etc/systemd/system/lyrashield-broker-authority-observer.service /etc/systemd/system/lyrashield-worker-authority-observer.socket /etc/systemd/system/lyrashield-worker-authority-observer.service /etc/systemd/system/lyrashield-native-executor.socket /etc/systemd/system/lyrashield-native-executor.service /etc/systemd/system/lyrashield-preparation-issuer.socket /etc/systemd/system/lyrashield-preparation-issuer.service
python3 - <<'PY'
import grp, os, signal, socket, time
import importlib.util
from pathlib import Path

# Real held-file checks for the worker credential/config boundary.
spec = importlib.util.spec_from_file_location('worker_observation', '/opt/lyrashield/runtime-control/worker-observation.py')
worker_observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker_observer)
configuration = Path('/etc/lyrashield/control/worker-authority.json')
configuration.write_bytes(b'{"schema":"fixture-config-read-only"}')
worker_gid = grp.getgrnam('lyrashield-worker').gr_gid
os.chown(configuration, 0, worker_gid)
configuration.chmod(0o440)
assert worker_observer.public_config(None, worker_gid) == configuration.read_bytes()
for change in ('wrong-group', 'writable', 'hardlink', 'symlink'):
    original = configuration.read_bytes()
    if change == 'wrong-group': os.chown(configuration, 0, grp.getgrnam('lyrashield-broker').gr_gid)
    if change == 'writable': configuration.chmod(0o640)
    if change == 'hardlink': os.link(configuration, configuration.with_suffix('.hardlink'))
    if change == 'symlink':
        configuration.unlink()
        configuration.symlink_to('/tmp/worker-authority-config')
        Path('/tmp/worker-authority-config').write_bytes(original)
    try:
        worker_observer.public_config(None, worker_gid)
    except (RuntimeError, OSError):
        pass
    else:
        raise AssertionError('Unprotected worker configuration must be rejected')
    if change == 'hardlink': configuration.with_suffix('.hardlink').unlink()
    configuration.unlink()
    configuration.write_bytes(original)
    os.chown(configuration, 0, worker_gid)
    configuration.chmod(0o440)
configuration.unlink()

def launch(server, arguments, fds='1', helper='authority-observer.py'):
    pid = os.fork()
    if pid == 0:
        os.dup2(server.fileno(), 3)
        os.set_inheritable(3, True)
        os.environ.update(LISTEN_PID=str(os.getpid()), LISTEN_FDS=fds)
        os.execv('/usr/bin/python3', ['/usr/bin/python3', '-I', '/opt/lyrashield/runtime-control/' + helper, *arguments])
    return pid

for path, group, arguments in (
    ('/run/lyrashield/control/authority.sock', 'lyrashield-supervisor', []),
    ('/run/lyrashield/control/broker-authority.sock', 'lyrashield-broker', ['--broker-read-only']),
    ('/run/lyrashield/control/worker-authority.sock', 'lyrashield-worker', ['--worker-read-only']),
):
    server = socket.socket(socket.AF_UNIX)
    server.bind(path)
    os.chown(path, 0, grp.getgrnam(group).gr_gid)
    os.chmod(path, 0o660)
    server.listen()
    pid = launch(server, arguments)
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(10)
            client.connect(path)
            client.sendall(b'worker-execution-authority\n' if group == 'lyrashield-worker' else b'execution-authority\n')
            assert client.recv(8192) == b'', 'Missing runtime authority must stay unavailable'
        child = os.fork()
        if child == 0:
            os.setgroups([])
            os.setgid(grp.getgrnam('lyrashield-broker' if group == 'lyrashield-supervisor' else 'lyrashield-supervisor').gr_gid)
            os.setuid(65534)
            try:
                with socket.socket(socket.AF_UNIX) as client:
                    client.connect(path)
            except PermissionError:
                os._exit(0)
            os._exit(1)
        _, status = os.waitpid(child, 0)
        assert os.waitstatus_to_exitcode(status) == 0, 'Other role must not access authority socket'
    finally:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
        server.close()

# The installed native daemon serves its fixed socket while missing credentials keep effects closed.
path = '/run/lyrashield/control/native-executor.sock'
server = socket.socket(socket.AF_UNIX)
server.bind(path)
os.chown(path, 0, grp.getgrnam('lyrashield-supervisor').gr_gid)
os.chmod(path, 0o660)
server.listen()
pid = launch(server, [], helper='native-executor.py')
try:
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(10)
        client.connect(path)
        client.sendall(b'{"schema":1,"method":"create","action":{},"guardId":"fixture-closed"}\n')
        assert client.recv(8192) == b'', 'Native effects must stay unavailable without protected authority'
    assert Path('/var/lib/lyrashield/native-executor/service.lock').is_file()
    assert not list(Path('/var/lib/lyrashield/native-executor').glob('*.json'))
finally:
    os.kill(pid, signal.SIGTERM)
    os.waitpid(pid, 0)
    server.close()

# Invalid activation must abort before it can invoke even a protected helper.
helper = Path('/opt/lyrashield/runtime-control/paired-runtime-host-observation.py')
helper.write_text("from pathlib import Path; Path('/tmp/observer-was-called').touch(); print('{}')\n")
helper.chmod(0o755)
for scenario in ('wrong-group', 'wrong-socket', 'multiple-fds'):
    expected = '/run/lyrashield/control/authority.sock'
    path = '/run/lyrashield/control/foreign.sock' if scenario == 'wrong-socket' else expected
    if Path(path).exists():
        Path(path).unlink()
    server = socket.socket(socket.AF_UNIX)
    server.bind(path)
    os.chown(path, 0, grp.getgrnam('lyrashield-broker' if scenario == 'wrong-group' else 'lyrashield-supervisor').gr_gid)
    os.chmod(path, 0o660)
    server.listen()
    if scenario == 'wrong-socket':
        os.chown(expected, 0, grp.getgrnam('lyrashield-supervisor').gr_gid)
    pid = launch(server, [], '2' if scenario == 'multiple-fds' else '1')
    try:
        for attempt in range(100):
            child, status = os.waitpid(pid, os.WNOHANG)
            if child:
                assert os.waitstatus_to_exitcode(status) != 0
                break
            time.sleep(0.05)
        else:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
            raise AssertionError('Invalid activation remained running')
        assert not Path('/tmp/observer-was-called').exists()
    finally:
        server.close()
PY
