"""Real installed-engine sandbox admission/isolation; controlled fixtures only."""
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import sys
import time
from uuid import uuid4

assert sys.platform == "linux"
KEYS = ("OPENAI_API_KEY", "AZURE_AI_API_KEY", "AZURE_OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LITELLM_API_KEY")
assert not any(os.environ.get(key) for key in KEYS), "real credentials forbidden"
site = Path(importlib.metadata.distribution("lyrashield-engine").locate_file(""))
for relative, digest in expected["engineFiles"].items():
    path = site / relative
    assert path.is_file() and not path.is_symlink()
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, relative
for package, version in expected["versions"].items():
    assert importlib.metadata.version(package) == version, package

import docker
from docker.errors import NotFound
from agents.sandbox.manifest import Environment, Manifest
from lyrashield.runtime.backends import docker_backend
from lyrashield.runtime.docker_client import _assert_sandbox_network_admission
from lyrashield.runtime.session_manager import build_sandbox_environment

SERVICE = '''from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200);self.end_headers();self.wfile.write(b'controlled-fixture')
    def log_message(self,*args): pass
ThreadingHTTPServer(('0.0.0.0',48081),Handler).serve_forever()
'''


def gone(transport, container_id):
    try:
        transport.containers.get(container_id)
    except NotFound:
        return True
    return False


async def main():
    transport = docker.from_env(timeout=30)
    owner = "cold-isolation-" + uuid4().hex
    network = None
    outside = None
    sessions = []
    results = []
    cleanup = False
    try:
        network = transport.networks.create(owner, internal=True, driver="bridge",
            options={"com.docker.network.bridge.enable_icc": "false"}, labels={"lyrashield.cold-native-owner": owner})
        network.reload()
        network_id = network.id
        assert len(network_id) == 64
        os.environ["STRIX_DOCKER_SANDBOX_NETWORK"] = network.name
        os.environ["STRIX_SANDBOX_ENABLE_NETWORK_CAPABILITIES"] = "0"
        os.environ["STRIX_SANDBOX_ALLOW_HOST_GATEWAY"] = "0"
        sentinel = "cold-provider-sentinel-" + uuid4().hex
        for key in KEYS:
            os.environ[key] = sentinel
        Path("/tmp/cold-provider-private").write_text(sentinel)
        environment = build_sandbox_environment("http://127.0.0.1:48080")
        assert not any(key in environment for key in KEYS)
        assert sentinel not in json.dumps(environment)
        # A real outside-network listener is positively reachable by this controller.
        outside = transport.containers.create(expected["workerImage"],
            entrypoint="/opt/lyrashield-venv/bin/python", command=["-I", "-c", SERVICE],
            network="bridge", environment={}, labels={"lyrashield.cold-native-owner": owner},
            read_only=True, cap_drop=["ALL"], security_opt=["no-new-privileges:true"],
            mem_limit="256m", pids_limit=64)
        outside_id = outside.id
        assert len(outside_id) == 64
        outside.start(); outside.reload()
        outside_ip = outside.attrs["NetworkSettings"]["Networks"]["bridge"]["IPAddress"]
        deadline = time.monotonic() + 20
        while True:
            try:
                with socket.create_connection((outside_ip, 48081), timeout=1):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise AssertionError("outside listener positive canary failed")
                await asyncio.sleep(0.1)
        for index in range(2):
            os.environ["STRIX_RUN_ID"] = owner + "-" + str(index)
            manifest = Manifest(environment=Environment(value=environment))
            client, session = await asyncio.wait_for(docker_backend(image=expected["sandboxImage"],
                manifest=manifest, exposed_ports=(48080,), bind_mounts=[]), timeout=90)
            container_id = session._inner.container_id
            container = transport.containers.get(container_id)
            sessions.append((client, session, container_id, os.environ["STRIX_RUN_ID"]))
            container.reload()
            _assert_sandbox_network_admission(container, transport)
            assert container.attrs["Config"]["Labels"]["strix-run-id"] == os.environ["STRIX_RUN_ID"]
            assert container.attrs["Image"] == expected["sandboxImageId"]
            assert not container.attrs["HostConfig"]["Privileged"]
            assert container.attrs["HostConfig"].get("PidMode") != "host"
            configured = container.attrs["Config"]["Env"]
            assert sentinel not in json.dumps(configured)
            assert not any(entry.split("=", 1)[0] in KEYS for entry in configured)
            assert not container.attrs.get("Mounts"), "fixture sandbox unexpectedly mounts host resources"
            script = '''import json, os
from pathlib import Path
assert os.getuid() != 0
keys = %r
assert not any(os.environ.get(key) for key in keys)
assert not Path('/var/run/docker.sock').exists()
assert not Path('/run/docker.sock').exists()
assert not Path('/tmp/cold-provider-private').exists()
for file in ('/proc/self/environ','/proc/1/environ'):
    try:
        contents=Path(file).read_bytes()
    except PermissionError:
        continue
    assert b'cold-provider-sentinel-' not in contents
print('ISOLATED')
''' % (KEYS,)
            result = await session.exec("/usr/bin/python3", "-I", "-c", script, shell=False, timeout=20)
            assert result.ok(), "credential probe failed: " + repr(result.stderr[-2000:])
            assert result.stdout.strip() == b"ISOLATED", "credential probe marker absent: " + repr(result.stdout[-200:])
            # Start a real listener using this actual non-root sandbox session.
            start = "import subprocess; subprocess.Popen(['/usr/bin/python3','-I','-c',%r],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)" % SERVICE
            result = await session.exec("/usr/bin/python3", "-I", "-c", start, shell=False, timeout=20)
            assert result.ok(), "listener startup failed: " + repr(result.stderr[-2000:])
            local = '''import socket,time
deadline=time.monotonic()+10
while True:
    try:
        with socket.create_connection(('127.0.0.1',48081),timeout=1): break
    except OSError:
        assert time.monotonic()<deadline
        time.sleep(.1)
print('LIVE')
'''
            result = await session.exec("/usr/bin/python3", "-I", "-c", local, shell=False, timeout=20)
            assert result.ok(), "loopback canary failed: " + repr(result.stderr[-2000:])
            assert result.stdout.strip() == b"LIVE"
        results.append({"name": "sandbox-provider-credentials-and-socket-absent", "exitCode": 0,
                        "sandboxCount": 2, "nonRoot": True, "configEnv": True, "environment": True,
                        "procEnvironment": True, "privateFileAbsent": True, "hostMountsAbsent": True})
        addresses = [transport.containers.get(cid).attrs["NetworkSettings"]["Networks"][network.name]["IPAddress"]
                     for _, _, cid, _ in sessions]
        for index, (_, session, _, _) in enumerate(sessions):
            script = '''import socket
for destination in (%r,%r):
    with socket.socket() as connection:
        connection.settimeout(2)
        assert connection.connect_ex((destination,48081)) != 0, 'unauthorized TCP reachable'
with socket.create_connection(('127.0.0.1',48081),timeout=2): pass
print('DENIED')
''' % (addresses[1-index], outside_ip)
            result = await session.exec("/usr/bin/python3", "-I", "-c", script, shell=False, timeout=20)
            assert result.ok(), "network denial failed: " + repr(result.stderr[-2000:])
            assert result.stdout.strip() == b"DENIED"
        results.append({"name": "sandbox-live-sibling-and-outside-provider-tcp-denied", "exitCode": 0,
                        "directions": 2, "siblingPositiveLoopbackCanary": True,
                        "outsideProviderPositiveCanary": True, "internalBridge": True, "iccDisabled": True})
    finally:
        for client, session, container_id, run_id in reversed(sessions):
            container = transport.containers.get(container_id)
            assert container.attrs["Config"]["Labels"]["strix-run-id"] == run_id
            assert container.attrs["Image"] == expected["sandboxImageId"]
            await asyncio.wait_for(client.delete(session), timeout=30)
            assert gone(transport, container_id), "native session deletion unconfirmed"
            client.docker_client.close()
        if outside is not None:
            outside.reload()
            assert outside.attrs["Config"]["Labels"]["lyrashield.cold-native-owner"] == owner
            assert outside.attrs["Image"] == expected["workerImageId"]
            outside.remove(force=True)
            assert gone(transport, outside.id)
        if network is not None:
            network.reload()
            assert network.attrs["Labels"]["lyrashield.cold-native-owner"] == owner
            assert not network.attrs["Containers"]
            network.remove()
            try:
                transport.networks.get(network.id)
            except NotFound:
                cleanup = True
            assert cleanup, "network cleanup unconfirmed"
        transport.close()
    assert cleanup and len(results) == 2
    print("COLD_NATIVE_RESULT=" + json.dumps({"cases": results, "cleanupVerified": cleanup,
        "sandboxContainerIds": [entry[2] for entry in sessions], "networkId": network_id,
        "outsideProviderContainerId": outside_id}, sort_keys=True))


asyncio.run(main())
