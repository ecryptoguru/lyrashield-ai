"""Real disposable PostgreSQL, relay and synthetic-provider observation."""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "observe_execution_context", HERE / "observe_execution_context.py"
)
observer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(observer)


def run(*args, input=None, env=None):
    result = subprocess.run(
        args,
        input=input,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
    return result.stdout.decode().strip()


class ExecutionContextTest(unittest.TestCase):
    def test_actual_owned_fixtures_and_substitutions(self):
        if any(
            os.environ.get(name)
            for name in (
                "DOCKER_HOST",
                "DOCKER_CONTEXT",
                "DOCKER_TLS_VERIFY",
                "DOCKER_CERT_PATH",
            )
        ):
            self.fail("Docker environment overrides are not allowed")
        self.assertIn(run("docker", "context", "show"), {"default", "desktop-linux"})
        self.assertTrue(
            run(
                "docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"
            ).startswith("unix:///")
        )
        postgres_image = run(
            "docker", "image", "inspect", "postgres:17-alpine", "--format", "{{.Id}}"
        )
        self.assertRegex(postgres_image, r"^sha256:[a-f0-9]{64}$")
        owner = os.urandom(24).hex()
        tag = "lyrashield-synthetic-provider-" + owner[:16]
        db = provider = image = ""
        relay = provider_relay = fault_relay = None
        previous_url = os.environ.get("LYRA_DISPOSABLE_DATABASE_URL")
        with tempfile.TemporaryDirectory(prefix="lyra-disposable-context-") as temp:
            root = Path(temp)
            try:
                shutil.copyfile(
                    HERE / "synthetic_provider.sh", root / "synthetic_provider.sh"
                )
                (root / "synthetic_provider.sh").chmod(0o755)
                (root / "Dockerfile").write_text(
                    "FROM postgres:17-alpine\nCOPY synthetic_provider.sh /opt/fixture/provider.sh\n"
                    'USER postgres\nENTRYPOINT ["/bin/busybox","nc","-lk","-s","127.0.0.1","-p","5432","-e","/opt/fixture/provider.sh"]\nCMD []\n',
                    encoding="utf-8",
                )
                run(
                    "docker",
                    "build",
                    "--network=none",
                    "--pull=false",
                    "-t",
                    tag,
                    str(root),
                    env={**os.environ, "DOCKER_BUILDKIT": "0"},
                )
                self.assertEqual(
                    run(
                        "docker",
                        "image",
                        "inspect",
                        "postgres:17-alpine",
                        "--format",
                        "{{.Id}}",
                    ),
                    postgres_image,
                )
                image = run("docker", "image", "inspect", tag, "--format", "{{.Id}}")
                password = os.urandom(24).hex()
                db = run(
                    "docker",
                    "create",
                    "--network",
                    "none",
                    "--label",
                    f"{observer.LABEL}={owner}",
                    "-e",
                    f"POSTGRES_PASSWORD={password}",
                    "-e",
                    "POSTGRES_DB=authority_test",
                    postgres_image,
                )
                provider = run(
                    "docker",
                    "create",
                    "--read-only",
                    "--tmpfs",
                    "/var/lib/postgresql/data:ro,noexec,nosuid,nodev",
                    "--network",
                    "none",
                    "--label",
                    f"{observer.LABEL}={owner}",
                    "--label",
                    "lyrashield.fixture-role=synthetic-provider",
                    image,
                )
                self.assertRegex(db, observer.ID)
                self.assertRegex(provider, observer.ID)
                run("docker", "start", db, provider)
                for _ in range(100):
                    ready = subprocess.run(
                        [
                            "docker",
                            "exec",
                            db,
                            "pg_isready",
                            "-U",
                            "postgres",
                            "-d",
                            "authority_test",
                        ],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    if ready.returncode == 0:
                        break
                    time.sleep(0.1)
                else:
                    self.fail("PostgreSQL fixture did not start")
                port_file = root / "relay-port"
                relay = subprocess.Popen(
                    [
                        shutil.which("python3"),
                        str(HERE / "relay.py"),
                        db,
                        str(port_file),
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                for _ in range(100):
                    if port_file.exists():
                        break
                    if relay.poll() is not None:
                        self.fail("database relay stopped")
                    time.sleep(0.05)
                self.assertTrue(port_file.exists())
                provider_port_file = root / "provider-port"
                provider_relay = subprocess.Popen(
                    [
                        shutil.which("python3"),
                        str(HERE / "relay.py"),
                        provider,
                        str(provider_port_file),
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                for _ in range(100):
                    if provider_port_file.exists():
                        break
                    if provider_relay.poll() is not None:
                        self.fail("provider relay stopped")
                    time.sleep(0.05)
                self.assertTrue(provider_port_file.exists())
                os.environ["LYRA_DISPOSABLE_DATABASE_URL"] = (
                    f"postgresql://postgres:{password}@127.0.0.1:{port_file.read_text().strip()}/authority_test?schema=public"
                )
                for _ in range(100):
                    try:
                        record = observer.observe(
                            db,
                            provider,
                            owner,
                            relay.pid,
                            port_file,
                            "authority_test",
                            provider_relay.pid,
                            provider_port_file,
                        )
                        break
                    except (urllib.error.URLError, ConnectionError):
                        time.sleep(0.05)
                else:
                    self.fail("provider fixture did not start")
                self.assertEqual(record["purpose"], "disposable-execution-observation")
                self.assertEqual(record["context"]["environment"], "DISPOSABLE")
                for key in (
                    "databaseIncarnationId",
                    "hostIdentityDigest",
                    "providerFixtureId",
                ):
                    self.assertRegex(record["context"][key], r"^sha256:[a-f0-9]{64}$")
                self.assertEqual(record["evidence"]["database"]["containerId"], db)
                self.assertEqual(
                    record["evidence"]["provider"]["containerId"], provider
                )
                self.assertGreater(
                    int(record["evidence"]["database"]["databaseOid"]), 0
                )
                self.assertGreater(
                    int(record["evidence"]["database"]["systemIdentifier"]), 0
                )
                self.assertTrue(
                    record["evidence"]["provider"]["endpoint"].startswith(
                        "http://127.0.0.1:"
                    )
                )
                self.assertEqual(json.loads(json.dumps(record)), record)
                fault_port_file = root / "fault-port"
                fault_args = [
                    str(root / name)
                    for name in (
                        "armed",
                        "dropped",
                        "delay",
                        "delayed",
                        "live-delay",
                        "live-delayed",
                        "live-stall",
                        "live-stalled",
                    )
                ]
                fault_relay = subprocess.Popen(
                    [
                        shutil.which("python3"),
                        str(observer.FAULT_RELAY_SOURCE),
                        db,
                        str(fault_port_file),
                        *fault_args,
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                for _ in range(100):
                    if fault_port_file.exists():
                        break
                    if fault_relay.poll() is not None:
                        self.fail("fault relay stopped")
                    time.sleep(0.05)
                self.assertTrue(fault_port_file.exists())
                os.environ["LYRA_DISPOSABLE_DATABASE_URL"] = (
                    f"postgresql://postgres:{password}@127.0.0.1:{fault_port_file.read_text().strip()}/authority_test?schema=public"
                )
                fault_record = observer.observe(
                    db,
                    provider,
                    owner,
                    fault_relay.pid,
                    fault_port_file,
                    "authority_test",
                    provider_relay.pid,
                    provider_port_file,
                )
                self.assertEqual(fault_record["context"], record["context"])
                with self.assertRaises(ValueError):
                    observer.observe(
                        db,
                        provider,
                        owner,
                        relay.pid,
                        port_file,
                        "authority_test",
                        provider_relay.pid,
                        provider_port_file,
                    )
                with self.assertRaises(ValueError):
                    observer.observe(
                        db,
                        provider,
                        "0" * 48,
                        relay.pid,
                        port_file,
                        "authority_test",
                        provider_relay.pid,
                        provider_port_file,
                    )
                with self.assertRaises(ValueError):
                    observer.observe(
                        db,
                        provider,
                        owner,
                        relay.pid,
                        port_file,
                        "production",
                        provider_relay.pid,
                        provider_port_file,
                    )
                with self.assertRaises(ValueError):
                    observer.observe(
                        db,
                        db,
                        owner,
                        relay.pid,
                        port_file,
                        "authority_test",
                        provider_relay.pid,
                        provider_port_file,
                    )
            finally:
                if previous_url is None:
                    os.environ.pop("LYRA_DISPOSABLE_DATABASE_URL", None)
                else:
                    os.environ["LYRA_DISPOSABLE_DATABASE_URL"] = previous_url
                if relay:
                    relay.terminate()
                    relay.wait(timeout=10)
                if provider_relay:
                    provider_relay.terminate()
                    provider_relay.wait(timeout=10)
                if fault_relay:
                    fault_relay.terminate()
                    fault_relay.wait(timeout=10)
                for container, expected in ((provider, image), (db, postgres_image)):
                    if container:
                        identity = run(
                            "docker",
                            "inspect",
                            "--format",
                            '{{.Id}}|{{.Image}}|{{index .Config.Labels "lyrashield.dispatch-authority-fixture"}}',
                            container,
                        )
                        if identity != f"{container}|{expected}|{owner}":
                            raise RuntimeError(
                                "fixture ownership changed; cleanup refused"
                            )
                        run("docker", "rm", "-f", "-v", container)
                if image:
                    if (
                        run("docker", "image", "inspect", tag, "--format", "{{.Id}}")
                        != image
                    ):
                        raise RuntimeError("fixture image changed; cleanup refused")
                    run("docker", "image", "rm", tag)


if __name__ == "__main__":
    unittest.main()
