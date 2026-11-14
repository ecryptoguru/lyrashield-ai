"""Real Linux filesystem boundaries for the fixed engine/source capture module."""

import base64
import copy
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location(
    "result_capture", HERE / "native-engine-result.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(
    os.geteuid() == 0 and os.uname().sysname == "Linux",
    "actual isolated Linux root filesystem required",
)
class EngineCaptureTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix="lyrashield-output-", dir="/var/lib"
        )
        self.root = Path(self.temporary.name)
        self.ledger = SimpleNamespace(root=self.root)
        module.ROOT = HERE
        module.INPUTS = self.root / "inputs"
        module.INPUTS.mkdir(mode=0o700)
        self.source = module.INPUTS / "source:fixed-attempt"
        self.source.mkdir(mode=0o700)
        (self.source / "z.txt").write_bytes(b"exact source\0bytes")
        (self.source / "a").mkdir()
        (self.source / "a" / "nested.txt").write_bytes(b"nested")
        (self.source / "empty").mkdir()
        for path in [*(self.source.rglob("*")), self.source]:
            path.chmod(0o555 if path.is_dir() else 0o444)
        tree = module.source_module().read_source_tree(self.source)
        self.ownership = {
            "executorKey": "engine",
            "kind": "container",
            "ownershipId": "own_" + "a" * 40,
            "containerId": "b" * 64,
        }
        action = {
            "phase": "EXECUTOR_CREATE",
            "operationId": "operation-fixed",
            "attemptId": "attempt-fixed",
            "scanId": "scan-fixed",
            "workspaceId": "workspace-fixed",
            "authorityEpochId": "epoch-fixed",
            "authorityRevision": 1,
            "authorityChecksum": "1" * 64,
            "actionChecksum": "2" * 64,
            "commandId": "command-fixed",
            "executorKey": "engine",
        }
        image = "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:" + "c" * 64
        self.output = (
            self.root
            / "output"
            / hashlib.sha256(self.ownership["ownershipId"].encode()).hexdigest()
        )
        self.output.parent.mkdir(mode=0o700)
        self.output.mkdir(mode=0o700)
        os.chown(self.output, 1000, 1000)
        self.run = self.output / action["scanId"]
        self.run.mkdir(mode=0o700)
        os.chown(self.run, 1000, 1000)
        self.write_output("run.json", b'{"run_id":"scan-fixed"}')
        self.write_output("vulnerabilities.json", b"[]")
        self.write_output("private-resume-key.json", b"NEVER EXPORT")
        plan = {
            "action": action,
            "ownership": {
                key: value
                for key, value in self.ownership.items()
                if key != "containerId"
            },
            "epochId": action["authorityEpochId"],
            "sourceRevision": "d" * 40,
            "engineRevision": "e" * 40,
            "image": image,
            "network": "network-fixed",
            "outputPath": str(self.output),
            "spec": {
                "resourceDescriptor": {
                    "uid": 1000,
                    "gid": 1000,
                    "source": {
                        "grantId": self.source.name,
                        "root": "/workspace/source",
                        "revision": "f" * 40,
                        "stagedTreeDigest": tree["stagedTreeDigest"],
                        "readOnly": True,
                    },
                }
            },
            "resources": {
                "mounts": [{"source": str(self.source), "target": "/workspace/source"}]
            },
        }
        self.origin = {
            "schema": 1,
            "guardId": "guard-fixed",
            "request": {"method": "create", "guardId": "guard-fixed", "action": action},
            "plan": plan,
            "state": "OBSERVED",
            "result": {"ownership": self.ownership},
        }
        self.row = {
            "Id": self.ownership["containerId"],
            "Image": "sha256:" + "3" * 64,
            "Config": {
                "Image": image,
                "Labels": {
                    "lyrashield.supervisor.ownership": self.ownership["ownershipId"],
                    "lyrashield.supervisor.attempt": action["attemptId"],
                },
            },
            "State": {
                "Running": False,
                "Status": "exited",
                "StartedAt": "2026-11-14T00:00:00Z",
                "FinishedAt": "2026-11-14T00:00:01Z",
                "ExitCode": 0,
            },
        }
        self.image = {
            "Id": self.row["Image"],
            "RepoDigests": [image],
            "Config": {
                "Labels": {
                    "org.opencontainers.image.revision": "d" * 40,
                    "com.lyrashield.engine.revision": "e" * 40,
                }
            },
        }

    def tearDown(self):
        for path in self.root.rglob("*"):
            if path.is_dir() and not path.is_symlink():
                path.chmod(0o700)
        self.temporary.cleanup()

    def write_output(self, name, raw):
        path = self.run / name
        path.write_bytes(raw)
        os.chown(path, 1000, 1000)
        return path

    def docker(self, args):
        if args[:2] == ["container", "inspect"]:
            self.assertEqual(args[2], self.ownership["containerId"])
            return json.dumps([self.row]).encode()
        self.assertEqual(args, ["image", "inspect", self.origin["plan"]["image"]])
        return json.dumps([self.image]).encode()

    def test_captures_exact_source_fixed_artifacts_and_retains_before_removal(self):
        raw = module.snapshot(self.ledger, self.origin, self.ownership, self.docker)
        bundle = json.loads(raw)
        self.assertEqual(bundle["schema"], "lyrashield-native-engine-output/1")
        self.assertEqual(bundle["action"], self.origin["plan"]["action"])
        self.assertEqual(set(bundle["artifacts"]), set(module.ARTIFACTS))
        self.assertEqual(bundle["artifacts"]["coverage.json"], "ABSENT")
        self.assertEqual(
            base64.b64decode(bundle["artifacts"]["vulnerabilities.json"]["base64"]),
            b"[]",
        )
        self.assertIn("empty", bundle["source"]["directories"])
        self.assertEqual(
            {item["path"] for item in bundle["source"]["files"]},
            {"z.txt", "a/nested.txt"},
        )
        self.assertNotIn(b"NEVER EXPORT", raw)
        proof = module.capture_engine_result(
            self.ledger, self.origin, self.ownership, self.docker
        )
        self.assertEqual(proof["sha256"], hashlib.sha256(raw).hexdigest())
        with patch.object(
            module,
            "snapshot",
            side_effect=AssertionError("Removed engine must use sealed bytes"),
        ):
            chunks = [
                module.read_engine_result_chunk(
                    self.ledger, self.origin, self.ownership, offset, 256, self.docker
                )
                for offset in range(0, len(raw), 256)
            ]
        self.assertEqual(
            b"".join(base64.b64decode(item["chunkBase64"]) for item in chunks), raw
        )
        self.assertEqual(
            os.stat(module.capture_path(self.ledger, self.ownership)).st_nlink, 1
        )

    def test_does_not_export_links_caps_races_or_changed_source(self):
        (self.run / "coverage.json").symlink_to(self.run / "private-resume-key.json")
        http = self.write_output("http_exchanges.json", b"{}")
        os.link(http, self.run / "http.alias")
        threat = self.write_output("threat_model.json", b"")
        with threat.open("wb") as stream:
            stream.truncate(module.ARTIFACTS["threat_model.json"] + 1)
        artifacts = module.export_artifacts(
            self.ledger, self.origin["plan"], module.MAX_BUNDLE
        )
        self.assertEqual(artifacts["coverage.json"], "UNREADABLE")
        self.assertEqual(artifacts["http_exchanges.json"], "UNREADABLE")
        self.assertEqual(artifacts["threat_model.json"], "CAPPED")
        changed = copy.deepcopy(self.origin["plan"])
        changed["spec"]["resourceDescriptor"]["source"]["stagedTreeDigest"] = "0" * 64
        self.assertIsNone(module.export_source(changed, module.MAX_BUNDLE))
        self.assertIsNone(module.export_source(self.origin["plan"], 2))
        fd = os.open(self.run, os.O_RDONLY | os.O_DIRECTORY)
        original_read = os.read

        def racing_read(descriptor, size):
            data = original_read(descriptor, size)
            if data:
                (self.run / "run.json").write_bytes(b"changed during held read")
            return data

        try:
            with patch.object(module.os, "read", side_effect=racing_read):
                with self.assertRaises(RuntimeError):
                    module.held_file(fd, "run.json", 1000, 1024)
        finally:
            os.close(fd)

    def test_rejects_running_wrong_owned_objects_and_capture_substitution(self):
        for change in ("running", "image", "container", "output-path"):
            original = copy.deepcopy(self.row)
            origin = copy.deepcopy(self.origin)
            if change == "running":
                self.row["State"]["Running"] = True
            if change == "image":
                self.row["Config"]["Image"] = "wrong-image"
            if change == "container":
                self.row["Id"] = "0" * 64
            if change == "output-path":
                origin["plan"]["outputPath"] = "/etc"
            if change == "output-path":
                self.assertEqual(
                    set(
                        module.export_artifacts(
                            self.ledger, origin["plan"], module.MAX_BUNDLE
                        ).values()
                    ),
                    {"UNREADABLE"},
                )
            else:
                with self.assertRaises(RuntimeError):
                    module.snapshot(self.ledger, origin, self.ownership, self.docker)
            self.row = original
        module.capture_engine_result(
            self.ledger, self.origin, self.ownership, self.docker
        )
        path = module.capture_path(self.ledger, self.ownership)
        raw = path.read_bytes()
        path.unlink()
        target = self.root / "capture-target"
        target.write_bytes(raw)
        path.symlink_to(target)
        with self.assertRaises(OSError):
            module.capture_engine_result(
                self.ledger, self.origin, self.ownership, self.docker
            )
        with self.assertRaises(RuntimeError):
            module.read_engine_result_chunk(
                self.ledger,
                self.origin,
                self.ownership,
                0,
                module.MAX_CHUNK + 1,
                self.docker,
            )

    def test_small_worker_proof_reads_only_assigned_current_root_capture(self):
        module.capture_engine_result(
            self.ledger, self.origin, self.ownership, self.docker
        )
        path = self.root / (
            hashlib.sha256(self.origin["guardId"].encode()).hexdigest() + ".json"
        )
        path.write_text(json.dumps(self.origin))
        path.chmod(0o600)
        self.ledger.path = lambda guard: (
            self.root / (hashlib.sha256(guard.encode()).hexdigest() + ".json")
        )
        self.ledger.read = lambda guard: json.loads(
            self.ledger.path(guard).read_bytes()
        )
        action = self.origin["plan"]["action"]
        assigned = {
            key: action[key]
            for key in ("operationId", "attemptId", "scanId", "workspaceId")
        }
        assigned["state"] = "RUNNING"
        authority = {
            "epochId": action["authorityEpochId"],
            "productRevision": "d" * 40,
            "engineRevision": "e" * 40,
            "workerDigest": "sha256:" + "c" * 64,
        }
        proof = module.read_operation_proof(self.ledger, assigned, authority)
        self.assertEqual(proof["action"], action)
        self.assertEqual(proof["guardId"], self.origin["guardId"])
        self.assertEqual(
            set(proof), {"action", "guardId", "ownership", "sha256", "totalBytes"}
        )
        with self.assertRaises(RuntimeError):
            module.read_operation_proof(
                self.ledger, {**assigned, "attemptId": "other-attempt"}, authority
            )
        with self.assertRaises(RuntimeError):
            module.read_operation_proof(
                self.ledger, assigned, {**authority, "epochId": "expired-epoch"}
            )


if __name__ == "__main__":
    unittest.main()
