"""Native ledger/protocol regressions. No runtime qualification is emitted here."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_executor", Path(__file__).with_name("native-executor.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


@unittest.skipUnless(os.geteuid() == 0, "Protected root ledger tests require disposable Linux root")
class NativeLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.ledger = native.NativeLedger(self.root)
        self.request = {"schema": 1, "method": "create", "guardId": "guard-1", "action": {"attemptId": "attempt-1"}}
        self.request["action"]["executorKey"] = "sandbox"
        self.plan = {"ownership": {"ownershipId": "own_" + "a" * 40, "executorKey": "sandbox"}, "action": self.request["action"]}

    def tearDown(self):
        self.temporary.cleanup()

    def test_committed_invocation_cannot_repeat_after_lost_ack(self):
        self.ledger.begin("guard-1", self.request, self.plan)
        with self.assertRaises(FileExistsError):
            self.ledger.begin("guard-1", self.request, self.plan)
        self.assertEqual(self.ledger.read("guard-1")["state"], "INVOKING")
        self.assertEqual(self.ledger.path("guard-1").stat().st_mode & 0o777, 0o600)

    def test_terminal_receipt_is_bound_and_not_overwritten(self):
        self.ledger.begin("guard-1", self.request, self.plan)
        self.ledger.record_exec("guard-1", "b" * 64)
        self.ledger.mark_started("guard-1", "b" * 64)
        self.ledger.complete("guard-1", {"state": "EXITED", "exitCode": 0})
        entry = self.ledger.read("guard-1")
        self.assertEqual(entry["state"], "OBSERVED")
        self.assertEqual(len(entry["receiptSha256"]), 64)
        self.ledger.mark_started("guard-1", "b" * 64)
        self.assertEqual(self.ledger.read("guard-1"), entry)
        with self.assertRaises(RuntimeError):
            self.ledger.complete("guard-1", {"state": "EXITED", "exitCode": 1})

    def test_scope_and_filesystem_cannot_be_substituted(self):
        self.ledger.begin("guard-1", self.request, self.plan)
        with self.assertRaises(RuntimeError):
            self.ledger.ownership({"ownershipId": "own_" + "f" * 40})
        with self.assertRaises(RuntimeError):
            self.ledger.path("../../escape")
        path = self.ledger.path("guard-1")
        path.unlink()
        target = self.root / "substituted"
        target.write_text(json.dumps({"guardId": "guard-1"}))
        path.symlink_to(target)
        with self.assertRaises(RuntimeError):
            self.ledger.read("guard-1")

    def test_census_rejects_foreign_source_image_and_duplicate_ownership(self):
        authority = {"epochId": "epoch-1", "productRevision": "b" * 40, "sandboxDigest": "sha256:" + "c" * 64}
        plan = dict(self.plan, schema=1, guardId="guard-1", epochId="epoch-1", sourceRevision="b" * 40,
                    image=native.executor_reference(authority, "sandbox"))
        self.ledger.begin("guard-1", self.request, plan)
        with patch.object(native, "NativeLedger", return_value=self.ledger), patch.object(native, "verify_executor_image"), patch.object(native, "inspect_owned", return_value={"state": "PRESENT", "ownership": {"containerId": "d" * 64}}):
            self.assertEqual(native.allowed_native_containers(authority), ["d" * 64])
            self.assertEqual(native.allowed_native_containers(dict(authority, epochId="foreign-epoch")), [])
            with self.assertRaises(RuntimeError):
                native.allowed_native_containers(dict(authority, sandboxDigest="sha256:" + "f" * 64))
            other = dict(self.request, guardId="guard-2")
            self.ledger.begin("guard-2", other, dict(plan, guardId="guard-2"))
            with self.assertRaises(RuntimeError):
                native.allowed_native_containers(authority)

    def test_lost_create_ack_retains_original_identity_for_actual_removal(self):
        action = dict(self.request["action"], commandId="start-1", operationId="operation-1", authorityEpochId="epoch-1", actionChecksum="e" * 64)
        plan = dict(self.plan, action=action)
        request = dict(self.request, action=action)
        self.ledger.begin("guard-1", request, plan)
        owned = dict(plan["ownership"], containerId="f" * 64)
        self.assertIsNone(self.ledger.retire("guard-1", "stop-1", owned))
        self.ledger.record_created("guard-1", {"state": "PRESENT", "running": False, "ownership": owned})
        # An expired/lost post-ACK fence stays INVOKING; this is a removal proof,
        # not an invocation ACK or permission to repeat Docker create.
        self.assertEqual(self.ledger.read("guard-1")["state"], "INVOKING")
        proof = self.ledger.retire("guard-1", "stop-1", owned)
        self.assertEqual(proof["guardId"], "guard-1")
        self.assertEqual(proof["ownership"], owned)
        self.assertEqual(proof, self.ledger.retire("guard-1", "stop-1", owned))
        with self.assertRaises(RuntimeError):
            self.ledger.retire("guard-1", "foreign-stop", owned)

    def test_tool_removal_retains_exec_identity_and_tombstones_undelivered_guard(self):
        action = dict(self.request["action"], commandId="start-1", operationId="operation-1", workspaceId="workspace-1", authorityEpochId="epoch-1")
        ownership = dict(self.plan["ownership"], kind="container", containerId="f" * 64)
        origin = {"plan": dict(self.plan, action=action)}
        pending = []
        for guard in ("tool-1", "tool-2"):
            descriptor = {"ownership": ownership, "request": {"requestId": guard}}
            action_json = native.canonical(descriptor)
            binding = dict(action, phase="SANDBOX_TOOL", commandId="prepare-1", requestId=guard,
                           actionChecksum=native.hashlib.sha256(action_json.encode()).hexdigest())
            pending.append({"guardId": guard, "bindingInputJson": native.canonical(binding), "actionInputJson": action_json,
                            "actionChecksum": binding["actionChecksum"], "commandInputChecksum": "a" * 64})
            if guard == "tool-1":
                self.ledger.begin(guard, {"method": "tool", "action": binding}, {"action": binding, "ownership": ownership, "descriptor": descriptor})
                self.ledger.record_exec(guard, "e" * 64)
        proofs = self.ledger.retire_tools(origin, pending, "stop-1", ownership)
        self.assertEqual(len(proofs), 2)
        self.assertEqual(self.ledger.read("tool-1")["execId"], "e" * 64)
        self.assertEqual(self.ledger.read("tool-2")["state"], "RETIRED")
        self.assertEqual(proofs, self.ledger.retire_tools(origin, pending, "stop-1", ownership))
        with self.assertRaises(FileExistsError):
            self.ledger.begin("tool-2", {}, {})
        with self.assertRaises(RuntimeError):
            self.ledger.retire_tools(origin, pending, "foreign-stop", ownership)

    def test_native_image_gate_rejects_emulated_architecture(self):
        authority = {"sandboxDigest": "sha256:" + "a" * 64, "engineRevision": "b" * 40}
        reference = native.executor_reference(authority, "sandbox")
        image = {"RepoDigests": [reference], "Architecture": "amd64", "Config": {"Labels": {
            "org.opencontainers.image.revision": authority["engineRevision"],
            "org.opencontainers.image.source": "https://github.com/ecryptoguru/lyrashield-engine"}}}
        plan = {"ownership": {"executorKey": "sandbox"}, "image": reference}
        with patch.object(native, "run_docker", return_value=json.dumps([image]).encode()), patch.object(native.os, "uname", return_value=SimpleNamespace(machine="aarch64")):
            with self.assertRaises(RuntimeError):
                native.verify_executor_image(authority, plan)
            image["Architecture"] = "arm64"
            with patch.object(native, "run_docker", return_value=json.dumps([image]).encode()):
                native.verify_executor_image(authority, plan)


if __name__ == "__main__":
    unittest.main()
