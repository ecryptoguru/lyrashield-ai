import hashlib
import importlib.util
import json
import re
import stat
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "worker_observation", Path(__file__).with_name("worker-observation.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WorkerObservationTest(unittest.TestCase):
    def setUp(self):
        self.expiry = "2020-01-01T00:00:00.000Z"
        self.worker = {"uid": 12004, "gid": 12004, "pid": 213}
        self.authority = {
            "schema": "lyrashield-installed-runtime-authority/1",
            "purpose": "launch-qualified-controller",
            "productRevision": "a" * 40,
            "workerDigest": "sha256:" + "b" * 64,
            "engineRevision": "c" * 40,
            "epochId": "epoch-original",
            "epoch": 4,
            "acceptanceDigest": "sha256:" + "d" * 64,
        }
        self.raw = json.dumps({"raw": json.dumps(self.authority)}).encode()
        credential = "original-worker-private-credential"
        self.configuration = {
            "schema": "lyrashield-worker-broker-installation/1",
            "workerCredential": credential,
            "authority": {
                "productRevision": self.authority["productRevision"],
                "workerImageDigest": self.authority["workerDigest"],
                "engineRevision": self.authority["engineRevision"],
                "authorityEpochId": "epoch-original",
                "epoch": 4,
                "workerInstanceId": "worker-original",
                "workerGrantId": "grant-original",
                "expiresAt": self.expiry,
            },
        }
        configuration = json.dumps(self.configuration).encode()
        self.configuration_bytes = configuration
        self.policy = {
            "schema": "lyrashield-runtime-host-policy/2",
            "components": {
                "worker": {
                    "environment": {
                        "LYRASHIELD_WORKER_INSTANCE_ID": "worker-original",
                        "LYRASHIELD_WORKER_INSTANCE_GRANT_ID": "grant-original",
                        "LYRASHIELD_WORKER_INSTALLATION_CHECKSUM": self.checksum(
                            configuration
                        ),
                    },
                    "credentialFiles": {
                        "LYRASHIELD_WORKER_INSTANCE_CREDENTIAL": "/private/worker-credential"
                    },
                },
                "broker": {
                    "credentialFiles": {
                        "LYRASHIELD_SCAN_EXECUTION_DATABASE_URL": "/private/broker-db"
                    }
                },
                "supervisor": {},
                "provider-gateway": {},
            },
        }
        self.policy_raw = json.dumps(self.policy).encode()
        self.authority["runtimePolicyDigest"] = self.checksum(self.policy_raw)
        self.private = {
            "/fixture-root/runtime-authority.json": self.raw,
            "/fixture-root/runtime-policy.json": self.policy_raw,
            "/private/worker-credential": credential.encode(),
            "/private/broker-db": b"postgresql://broker:private@db:5432/app",
            str(
                module.ENV
            ): b"WORKER_OBSERVER_DATABASE_URL=postgresql://app_native_origin_reader:private@db:5432/app",
        }
        self.observer = SimpleNamespace(
            ROOT=Path("/fixture-root"),
            FIELDS=("productRevision", "workerDigest", "engineRevision"),
            ROLES=("broker", "supervisor", "provider-gateway", "worker"),
            IDENTIFIER=re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{2,191}"),
            checksum=self.checksum,
            canonical=lambda value: json.dumps(value, separators=(",", ":")),
            read_private=Mock(side_effect=lambda path, *args: self.private[str(path)]),
            verify_envelope=Mock(return_value=self.authority),
            component=Mock(return_value=self.worker),
            load_execution_authority=Mock(
                return_value={"authorityDigest": self.checksum(self.raw)}
            ),
        )
        self.operations = [
            {
                "operationId": "operation-original",
                "workspaceId": "workspace-original",
                "scanId": "scan-original",
                "attemptId": "attempt-original",
                "state": "STOPPING",
            }
        ]
        self.queries = []

    @staticmethod
    def checksum(raw):
        return "sha256:" + hashlib.sha256(raw).hexdigest()

    def run_observation(self, request, response_change=None, peer=(212, 12004, 12004)):
        def query(*args, **kwargs):
            submitted = json.loads(kwargs["input"])
            self.queries.append(submitted)
            cleanup = submitted.get("cleanup") is True
            result = {
                "schema": "lyrashield-root-worker-grant-observation/1",
                "current": not cleanup,
                "expiresAt": self.expiry,
            }
            if cleanup:
                result["cleanup"] = True
            if submitted.get("operations"):
                result["operations"] = self.operations
            if response_change:
                result.update(response_change)
            return SimpleNamespace(returncode=0, stdout=json.dumps(result).encode())

        def read(path):
            if str(path).endswith("runtime-qualification-key.json"):
                return b'{"keyId":"original-managed-pin"}'
            if str(path).endswith("worker-authority.json"):
                return self.configuration_bytes
            if str(path).endswith("cgroup"):
                return b"exact-original-worker-cgroup"
            raise AssertionError(str(path))

        metadata = SimpleNamespace(
            st_mode=stat.S_IFREG | 0o400, st_uid=0, st_gid=0, st_nlink=1, st_size=1024
        )
        with ExitStack() as stack:
            stack.enter_context(
                patch.object(
                    module, "public_config", return_value=self.configuration_bytes
                )
            )
            stack.enter_context(patch.object(Path, "lstat", return_value=metadata))
            stack.enter_context(patch.object(Path, "stat", return_value=metadata))
            stack.enter_context(patch.object(Path, "read_bytes", read))
            stack.enter_context(
                patch.object(module.subprocess, "run", side_effect=query)
            )
            return module.observe(peer, self.observer, request)

    def test_expired_grant_only_returns_explicit_cleanup_authority(self):
        result = self.run_observation({"schema": 1, "method": "cleanup-authority"})
        self.assertEqual(result["purpose"], "production-worker-installed-cleanup")
        self.assertEqual(result["expiresAt"], self.expiry)
        self.assertEqual(result["authorityEpochId"], "epoch-original")
        self.observer.load_execution_authority.assert_not_called()
        self.assertTrue(self.queries[0]["cleanup"])
        self.assertNotIn("operations", self.queries[0])
        self.assertEqual(self.queries[0]["workerGrantId"], "grant-original")
        self.observer.component.assert_called_with(
            "worker", self.policy, self.authority, retained_cleanup=True
        )
        with self.assertRaises(RuntimeError):
            self.run_observation(None)
        self.observer.load_execution_authority.assert_called_once()

    def test_cleanup_inventory_keeps_original_attempt_and_bounded_cursor(self):
        result = self.run_observation(
            {"schema": 1, "method": "cleanup-inventory", "cursor": "operation-cursor"}
        )
        self.assertEqual(result["operations"], self.operations)
        self.assertEqual(
            result["authority"]["purpose"], "production-worker-installed-cleanup"
        )
        self.assertEqual(self.queries[0]["cursor"], "operation-cursor")
        self.assertTrue(self.queries[0]["operations"])

    def test_expired_current_inventory_and_result_proof_remain_closed(self):
        for request in (
            {"schema": 1, "method": "inventory"},
            {
                "schema": 1,
                "method": "result-proof",
                "operationId": "operation-original",
            },
        ):
            with self.subTest(request=request), self.assertRaises(RuntimeError):
                self.run_observation(request)
        self.assertTrue(all("cleanup" not in query for query in self.queries))
        self.observer.component.assert_called_with(
            "worker", self.policy, self.authority, retained_cleanup=False
        )

    def test_cleanup_still_requires_signature_and_stable_measured_worker(self):
        request = {"schema": 1, "method": "cleanup-authority"}
        self.observer.verify_envelope.side_effect = ValueError("Invalid signature")
        with self.assertRaises(ValueError):
            self.run_observation(request)
        self.assertEqual(self.queries, [])
        self.observer.verify_envelope.side_effect = None
        self.observer.component.side_effect = [self.worker, {**self.worker, "pid": 214}]
        with self.assertRaises(RuntimeError):
            self.run_observation(request)

    def test_cleanup_cannot_accept_current_marker_other_peer_or_changed_config(self):
        request = {"schema": 1, "method": "cleanup-authority"}
        for change in (
            {"current": True},
            {"cleanup": False},
            {"expiresAt": "invalid"},
            {"operations": []},
        ):
            with (
                self.subTest(change=change),
                self.assertRaises((RuntimeError, ValueError)),
            ):
                self.run_observation(request, change)
        with self.assertRaises(RuntimeError):
            self.run_observation(request, peer=(212, 12002, 12002))
        changed = {**self.configuration, "workerCredential": "another-credential"}
        self.configuration_bytes = json.dumps(changed).encode()
        with self.assertRaises(RuntimeError):
            self.run_observation(request)

    def test_cleanup_rejects_unbounded_inventory_and_output_requests(self):
        self.operations *= 33
        with self.assertRaises(RuntimeError):
            self.run_observation({"schema": 1, "method": "cleanup-inventory"})
        for request in (
            {
                "schema": 1,
                "method": "cleanup-result-proof",
                "operationId": "operation-original",
            },
            {
                "schema": 1,
                "method": "cleanup-authority",
                "cursor": "operation-original",
            },
            {
                "schema": 1,
                "method": "cleanup-inventory",
                "operationId": "operation-original",
            },
        ):
            with self.assertRaises(RuntimeError):
                self.run_observation(request)


if __name__ == "__main__":
    unittest.main()
