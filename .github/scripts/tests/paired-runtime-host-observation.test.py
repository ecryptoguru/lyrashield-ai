import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / "paired-runtime-host-observation.py"
spec = importlib.util.spec_from_file_location("runtime_observation", PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeObservationTest(unittest.TestCase):
    def test_supervisor_socket_group_is_not_shared_with_other_roles(self):
        roles = {
            "broker": {"uid": 12001, "gid": 12001},
            "supervisor": {"uid": 12002, "gid": 12002},
            "provider-gateway": {"uid": 12003, "gid": 12003},
            "worker": {"uid": 12004, "gid": 12004},
        }
        module.verify_controller_role_ids(roles, 12002)
        with self.assertRaises(ValueError):
            module.verify_controller_role_ids(roles, 12005)
        for role in ("broker", "provider-gateway", "worker"):
            with self.subTest(role=role):
                shared = {name: dict(identity) for name, identity in roles.items()}
                shared[role]["gid"] = roles["supervisor"]["gid"]
                with self.assertRaises(ValueError):
                    module.verify_controller_role_ids(shared, 12002)

    def test_process_cannot_acquire_another_roles_socket_group(self):
        identity = {"uid": 12004, "gid": 12004}
        status = {"Uid": "12004 " * 4, "Gid": "12004 " * 4, "Groups": "12004"}
        module.verify_process_identity(status, identity)
        module.verify_process_identity({**status, "Groups": ""}, identity)
        for groups in ("0", "12002", "12004 12002"):
            with self.subTest(groups=groups):
                with self.assertRaises(ValueError):
                    module.verify_process_identity({**status, "Groups": groups}, identity)

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.key = Path(cls.directory.name) / "key.pem"
        subprocess.run(
            [
                "openssl",
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:3072",
                "-out",
                str(cls.key),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        modulus = (
            subprocess.run(
                ["openssl", "rsa", "-in", str(cls.key), "-modulus", "-noout"],
                check=True,
                capture_output=True,
                text=True,
            )
            .stdout.strip()
            .split("=")[1]
        )
        cls.pin = {
            "keyId": "fixture-only",
            "algorithm": "RS256",
            "publicKey": {
                "kty": "RSA",
                "n": base64.urlsafe_b64encode(bytes.fromhex(modulus))
                .decode()
                .rstrip("="),
                "e": "AQAB",
            },
        }

        cls.grant_key = Path(cls.directory.name) / "grant.pem"
        subprocess.run(
            [
                "openssl",
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:3072",
                "-out",
                str(cls.grant_key),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        grant_modulus = (
            subprocess.run(
                ["openssl", "rsa", "-in", str(cls.grant_key), "-modulus", "-noout"],
                check=True,
                capture_output=True,
                text=True,
            )
            .stdout.strip()
            .split("=")[1]
        )
        cls.signer = {
            "schema": "lyrashield-sandbox-grant-signer/1",
            "purpose": "sandbox-tool-grants",
            "algorithm": "RS256",
            "keyId": "sandbox-grant:epoch-2",
            "epochId": "epoch-2",
            "epoch": 2,
            "publicKey": {
                "kty": "RSA",
                "n": base64.urlsafe_b64encode(bytes.fromhex(grant_modulus))
                .decode()
                .rstrip("="),
                "e": "AQAB",
            },
        }
        cls.signer["publicKeySha256"] = module.checksum(module.public_der(cls.signer))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def envelope(self, changes=None):
        expected = {
            field: ("a" * 40 if field.endswith("Revision") else "sha256:" + "b" * 64)
            for field in module.FIELDS
        }
        record = {
            **expected,
            "schema": "lyrashield-installed-runtime-authority/1",
            "purpose": "launch-qualified-controller",
            "epochId": "epoch-2",
            "epoch": 2,
            "issuedAt": 100,
            "acceptanceDigest": "sha256:" + "c" * 64,
            "sandboxGrantSigner": json.loads(json.dumps(self.signer)),
            "toolChannel": {
                "schema": "lyrashield-sandbox-tool-channel/1",
                "origin": "https://supervisor.internal:3201",
            },
            "issuer": {
                "repositoryId": "1286618458",
                "repositoryOwnerId": "116722580",
                "workflow": ".github/workflows/issue-runtime-qualification.yml",
                "source": expected["productRevision"],
                "runId": "42",
                "attempt": "1",
            },
        }
        record.update(changes or {})
        raw = module.canonical(record)
        signature = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", str(self.key)],
            input=raw.encode(),
            check=True,
            capture_output=True,
        ).stdout
        return json.dumps(
            {
                "raw": raw,
                "result": {
                    "algorithm": "RS256",
                    "keyId": self.pin["keyId"],
                    "signature": base64.b64encode(signature).decode(),
                },
            }
        ).encode(), expected

    def test_real_signature_exact_tuple_and_issue_time(self):
        raw, expected = self.envelope()
        self.assertEqual(
            module.verify_envelope(raw, self.pin, expected, 200)["epoch"], 2
        )
        for changes in (
            {"purpose": "bounded-inventory-evidence-only"},
            {"epoch": 0},
            {"expiresAt": 2000},
            {"issuedAt": 201},
            {"productRevision": "d" * 40},
        ):
            raw, expected = self.envelope(changes)
            with self.assertRaises(ValueError):
                module.verify_envelope(raw, self.pin, expected, 200)
        with self.assertRaises(ValueError):
            module.verify_envelope(self.envelope()[0], self.pin, expected, 99)

    def test_tool_channel_has_one_exact_https_origin(self):
        for origin in (
            "http://supervisor.internal:3201",
            "https://user@supervisor.internal",
            "https://supervisor.internal/",
            "https://supervisor.internal/?x=1",
            "https://supervisor.internal#x",
            "https://Supervisor.internal",
            "https://supervisor.internal:443",
            "https://supervisor.internal:0",
            "https://supervisor.internal:70000",
            "https://supervisor..internal",
            "https://supervisor.internal:03201",
        ):
            raw, expected = self.envelope(
                {
                    "toolChannel": {
                        "schema": "lyrashield-sandbox-tool-channel/1",
                        "origin": origin,
                    }
                }
            )
            with self.assertRaises(ValueError):
                module.verify_envelope(raw, self.pin, expected, 200)

    def test_delegation_has_one_exact_epoch_role_source_and_distinct_key(self):
        derived = module.output(
            ["openssl", "pkey", "-pubout", "-outform", "DER"],
            input_bytes=self.grant_key.read_bytes(),
            limit=1024,
        )
        self.assertEqual(derived, module.public_der(self.signer))
        self.assertNotEqual(derived, module.public_der(self.pin))
        for signer in [
            {**self.signer, "purpose": "runtime-qualification"},
            {**self.signer, "epoch": 3},
            {**self.signer, "publicKeySha256": "sha256:" + "d" * 64},
            {
                **self.signer,
                "publicKey": self.pin["publicKey"],
                "publicKeySha256": module.checksum(module.public_der(self.pin)),
            },
        ]:
            raw, expected = self.envelope({"sandboxGrantSigner": signer})
            with self.assertRaises(ValueError):
                module.verify_envelope(raw, self.pin, expected, 200)
        raw, expected = self.envelope()
        issuer = json.loads(json.loads(raw)["raw"])["issuer"]
        raw, expected = self.envelope(
            {"issuer": {**issuer, "workflow": ".github/workflows/ci.yml"}}
        )
        with self.assertRaises(ValueError):
            module.verify_envelope(raw, self.pin, expected, 200)

    def test_changed_bytes_or_signature_cannot_qualify(self):
        raw, expected = self.envelope()
        envelope = json.loads(raw)
        envelope["raw"] = envelope["raw"].replace("epoch-2", "epoch-3")
        with self.assertRaises(subprocess.SubprocessError):
            module.verify_envelope(
                json.dumps(envelope).encode(), self.pin, expected, 200
            )
        envelope["result"]["keyId"] = "different-key"
        with self.assertRaises(ValueError):
            module.verify_envelope(
                json.dumps(envelope).encode(), self.pin, expected, 200
            )

    def test_missing_installed_authority_never_inspects_docker(self):
        with (
            patch.object(module, "ROOT", Path("/missing-runtime-observation-fixture")),
            patch.object(module, "output") as operation,
        ):
            with self.assertRaises(OSError):
                module.observe({}, self.pin)
            operation.assert_not_called()

    @unittest.skipUnless(
        __import__("os").geteuid() == 0,
        "root filesystem check runs in disposable Linux container",
    )
    def test_signed_policy_binds_the_exact_root_control_stream(self):
        source = "a" * 40
        control = {
            "schema": "lyrashield-journal-seal-control/1",
            "productRevision": source,
            "epochId": "epoch-2",
            "epoch": 2,
            "streamId": "stream-2",
            "supervisorInstanceId": "supervisor-2",
            "originalKeyHash": "c" * 64,
            "wrapperKeyHash": "d" * 64,
            "checkpointKeyHash": "e" * 64,
            "controlAccountId": "f" * 32,
            "controlCredentialId": "a" * 32,
            "controlBucket": "lyrashield-runtime-control",
            "genesisRecordHash": "1" * 64,
            "databaseRole": "lyrashield_journal_seal_control",
        }
        with tempfile.TemporaryDirectory(dir="/run") as directory:
            root = Path(directory)
            policy = {
                "schema": "lyrashield-runtime-host-policy/1",
                "journalSealControl": control,
            }
            policy_raw = module.canonical(policy).encode()
            (root / "runtime-policy.json").write_bytes(policy_raw)
            (root / "runtime-policy.json").chmod(0o600)
            raw, _ = self.envelope({"runtimePolicyDigest": module.checksum(policy_raw)})
            (root / "runtime-authority.json").write_bytes(raw)
            (root / "runtime-authority.json").chmod(0o600)
            with patch.object(module, "ROOT", root):
                self.assertEqual(
                    module.load_seal_gate_configuration(source, self.pin)["streamId"],
                    "stream-2",
                )
                with self.assertRaises(ValueError):
                    module.load_seal_gate_configuration("b" * 40, self.pin)
                observed = {
                    "authorityDigest": module.checksum(raw),
                    "runtimePolicyDigest": module.checksum(policy_raw),
                }
                with patch.object(module, "observe", return_value=observed):
                    capability = module.load_execution_authority(self.pin)
                    self.assertEqual(capability["purpose"], "production-installed")
                    self.assertEqual(capability["epochId"], "epoch-2")
                    self.assertEqual(capability["sourceRevision"], source)
                    self.assertEqual(capability["supervisorInstanceId"], "supervisor-2")
                with patch.object(
                    module, "observe", side_effect=ValueError("missing runtime")
                ):
                    with self.assertRaises(ValueError):
                        module.load_execution_authority(self.pin)
                with patch.object(
                    module,
                    "observe",
                    return_value={**observed, "authorityDigest": "sha256:" + "0" * 64},
                ):
                    with self.assertRaises(ValueError):
                        module.load_execution_authority(self.pin)
                policy["journalSealControl"]["controlBucket"] = (
                    "lyrashield-authority-journal"
                )
                changed = module.canonical(policy).encode()
                (root / "runtime-policy.json").write_bytes(changed)
                with self.assertRaises(ValueError):
                    module.load_seal_gate_configuration(source, self.pin)
                raw, _ = self.envelope(
                    {"runtimePolicyDigest": module.checksum(changed)}
                )
                (root / "runtime-authority.json").write_bytes(raw)
                with self.assertRaises(ValueError):
                    module.load_seal_gate_configuration(source, self.pin)

    def test_private_root_files_reject_symlinks_hardlinks_permissions_and_size(self):
        import os

        with tempfile.TemporaryDirectory(dir="/run") as directory:
            root = Path(directory)
            target = root / "authority.json"
            target.write_bytes(b"private-fixture")
            target.chmod(0o600)
            self.assertEqual(module.read_private(target), b"private-fixture")
            target.chmod(0o644)
            with self.assertRaises(ValueError):
                module.read_private(target)
            target.chmod(0o600)
            link = root / "link"
            link.symlink_to(target)
            with self.assertRaises(OSError):
                module.read_private(link)
            os.link(target, root / "hardlink")
            with self.assertRaises(ValueError):
                module.read_private(target)
            (root / "hardlink").unlink()
            with self.assertRaises(ValueError):
                module.read_private(target, 2)

    def test_subprocess_output_is_bounded_before_capture(self):
        import sys

        with self.assertRaises(subprocess.SubprocessError):
            module.output([sys.executable, "-c", 'print("x" * 1000000)'], limit=1024)

    def test_immutable_image_source_and_revision_are_required(self):
        reference = "ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:" + "a" * 64
        image = {
            "Id": "sha256:" + "b" * 64,
            "RepoDigests": [reference],
            "Config": {
                "Labels": {
                    "org.opencontainers.image.revision": "c" * 40,
                    "org.opencontainers.image.source": "https://github.com/ecryptoguru/lyrashield-engine",
                }
            },
        }
        with patch.object(module, "output", return_value=json.dumps([image]).encode()):
            self.assertEqual(
                module.inspect_image(
                    reference,
                    "c" * 40,
                    "https://github.com/ecryptoguru/lyrashield-engine",
                ),
                image,
            )
            for revision, source in [
                ("d" * 40, "https://github.com/ecryptoguru/lyrashield-engine"),
                ("c" * 40, "https://github.com/untrusted/repo"),
            ]:
                with self.assertRaises(ValueError):
                    module.inspect_image(reference, revision, source)
        image["RepoDigests"] = []
        with patch.object(module, "output", return_value=json.dumps([image]).encode()):
            with self.assertRaises(ValueError):
                module.inspect_image(
                    reference,
                    "c" * 40,
                    "https://github.com/ecryptoguru/lyrashield-engine",
                )


@unittest.skipUnless(
    __import__("os").environ.get("LYRASHIELD_RUNTIME_OBSERVATION_NATIVE") == "1",
    "opt-in disposable local Docker proof",
)
class NativeRuntimeObservationTest(unittest.TestCase):
    def test_real_published_image_identity(self):
        reference = "ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:7747ea2abd056bf573e5851e5ced049f3ce508cb6cfbbdc7683f89b258daa64f"
        image = module.inspect_image(
            reference,
            "eaef8bfc2f701f323d4007b26474e1626e5a0a28",
            "https://github.com/ecryptoguru/lyrashield-engine",
        )
        self.assertEqual(image["Id"], reference.split("@")[1])
        with self.assertRaises(ValueError):
            module.inspect_image(
                reference, "d" * 40, "https://github.com/ecryptoguru/lyrashield-engine"
            )

    def test_actual_restricted_database_epoch_and_closed_or_superseded_authority(self):
        import os
        import time
        import uuid

        name = "lyrashield-observation-pg-" + uuid.uuid4().hex[:12]

        def docker(*args):
            return subprocess.run(
                ["docker", *args],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            ).stdout.strip()

        container = docker(
            "run",
            "-d",
            "--name",
            name,
            "-e",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "-e",
            "POSTGRES_DB=observation",
            "-p",
            "127.0.0.1::5432",
            "postgres:17-alpine",
        )
        try:
            until = time.monotonic() + 15
            while subprocess.run(
                [
                    "docker",
                    "exec",
                    container,
                    "sh",
                    "-c",
                    '[ "$(cat /proc/1/comm)" = postgres ] && pg_isready -U postgres -d observation >/dev/null',
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode:
                if time.monotonic() >= until:
                    self.fail("disposable PostgreSQL did not become ready")
                time.sleep(0.2)
            sql = 'CREATE ROLE observation_runtime LOGIN; CREATE TABLE "ScanAuthorityEpoch" (id text, epoch integer, "isOpen" boolean, "openKey" text); GRANT SELECT ON "ScanAuthorityEpoch" TO observation_runtime; INSERT INTO "ScanAuthorityEpoch" VALUES (\'epoch-1\',1,false,NULL),(\'epoch-2\',2,true,\'open\');'
            docker(
                "exec",
                container,
                "psql",
                "-U",
                "postgres",
                "-d",
                "observation",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                sql,
            )
            port = json.loads(docker("inspect", container))[0]["NetworkSettings"][
                "Ports"
            ]["5432/tcp"][0]["HostPort"]
            package = str(PATH.parents[2] / "packages/db/package.json")
            probe = module.EPOCH_PROBE.replace(
                "'/app/packages/db/package.json'", json.dumps(package)
            )

            def read(role="observation_runtime"):
                env = {
                    **os.environ,
                    "DATABASE_URL": "postgresql://"
                    + role
                    + "@127.0.0.1:"
                    + port
                    + "/observation",
                    "LYRASHIELD_AUTHORITY_EPOCH_ID": "epoch-2",
                }
                return subprocess.run(
                    ["node", "-e", probe],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=15,
                )

            result = read()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                json.loads(result.stdout), {"epochId": "epoch-2", "epoch": 2}
            )
            self.assertNotEqual(read("postgres").returncode, 0)
            for change in [
                'UPDATE "ScanAuthorityEpoch" SET "isOpen"=false,"openKey"=NULL WHERE id=\'epoch-2\'',
                "INSERT INTO \"ScanAuthorityEpoch\" VALUES ('epoch-3',3,false,NULL)",
            ]:
                docker(
                    "exec",
                    container,
                    "psql",
                    "-U",
                    "postgres",
                    "-d",
                    "observation",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-c",
                    change,
                )
                self.assertNotEqual(read().returncode, 0)
        finally:
            subprocess.run(
                ["docker", "rm", "-f", container],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def test_actual_restricted_process_and_changed_launch(self):
        import time
        import uuid

        prefix = "lyrashield-observation-test-" + uuid.uuid4().hex[:12]
        image_name, network = prefix + ":fixture", prefix
        containers = []

        def docker(*args):
            return subprocess.run(
                ["docker", *args],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            ).stdout.strip()

        try:
            with tempfile.TemporaryDirectory() as directory:
                Path(directory, "Dockerfile").write_text(
                    'FROM python:3.12-slim\nUSER 12004:12004\nHEALTHCHECK --interval=1s --timeout=1s CMD python3 -c "pass"\nCMD ["python3", "-c", "import time; time.sleep(120)"]\n'
                )
                docker(
                    "build",
                    "--network",
                    "none",
                    "--pull=false",
                    "-q",
                    "-t",
                    image_name,
                    directory,
                )
            docker("network", "create", "--internal", network)
            image = json.loads(docker("image", "inspect", image_name))[0]
            identity = {
                "uid": 12004,
                "gid": 12004,
                "environment": {},
                "credentialFiles": {},
                "processCommand": image["Config"]["Cmd"],
            }
            for change in ("none", "root", "writable", "argv"):
                args = [
                    "run",
                    "-d",
                    "--network",
                    network,
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges",
                ]
                if change != "writable":
                    args.append("--read-only")
                if change == "root":
                    args += ["--user", "0:0"]
                args.append(image_name)
                if change == "argv":
                    args += ["python3", "-c", "import time; time.sleep(119)"]
                container_id = docker(*args)
                containers.append(container_id)
                until = time.monotonic() + 10
                while True:
                    container = json.loads(docker("inspect", container_id))[0]
                    if container["State"].get("Health", {}).get("Status") == "healthy":
                        break
                    if time.monotonic() >= until:
                        self.fail("disposable process did not become healthy")
                    time.sleep(0.2)
                if change == "none":
                    self.assertTrue(
                        module.verify_container(
                            container, image, image_name, identity, network
                        )["Running"]
                    )
                else:
                    with self.assertRaises(ValueError):
                        module.verify_container(
                            container, image, image_name, identity, network
                        )
            # A local fixture config ID is not a published qualified product image.
            with self.assertRaises(ValueError):
                module.inspect_image(
                    image_name, "a" * 40, "https://github.com/ecryptoguru/lyrashield-ai"
                )
        finally:
            for container in containers:
                subprocess.run(
                    ["docker", "rm", "-f", container],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            subprocess.run(
                ["docker", "network", "rm", network],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            subprocess.run(
                ["docker", "image", "rm", image_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )


if __name__ == "__main__":
    unittest.main()
