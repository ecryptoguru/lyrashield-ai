import copy
import importlib.util
import os
from pathlib import Path
import struct
import time
import unittest
import uuid
from unittest.mock import patch


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


root = Path(__file__).resolve().parents[1]
pty = load(root / "native-executor-pty.py")
shared = load(Path(__file__).with_name("native-executor-tool.test.py"))


class OutputTests(unittest.TestCase):
    def test_real_tty_bytes_and_non_tty_docker_frames_are_distinct(self):
        output = bytearray(b"native\r\n")
        self.assertEqual(pty.frame_output(output, True), b"native\r\n")
        self.assertEqual(output, b"")
        framed = bytearray(b"\x01\0\0\0" + struct.pack(">I", 6) + b"native")
        self.assertEqual(pty.frame_output(framed, False), b"native")
        with self.assertRaises(RuntimeError):
            pty.frame_output(bytearray(b"\x04\0\0\0\0\0\0\0"), False)

    def test_session_identity_is_deterministic_and_bounded(self):
        self.assertEqual(pty.session_id("guard-1"), pty.session_id("guard-1"))
        self.assertNotEqual(pty.session_id("guard-1"), pty.session_id("guard-2"))
        self.assertLessEqual(pty.session_id("guard-1"), 4503599627370496)


@unittest.skipUnless(os.getenv("LYRA_NATIVE_TOOL_DOCKER_TEST") == "1", "needs disposable Linux Docker")
class DockerPtyTests(unittest.TestCase):
    def setUp(self):
        self.fixture = shared.DockerTests(methodName="test_exact_output_and_single_use_ledger")
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()

    def start(self, argv, duration=4, limit=8192):
        plan = self.fixture.sandbox(argv, duration=duration, limit=limit)
        plan["descriptor"].update(resultKind="pty/start", pty={"tty": True, "yieldTimeSeconds": 0, "maxOutputTokens": 1000})
        request = {"schema": 1, "method": "tool", "guardId": plan["guardId"], "action": plan["action"]}
        self.fixture.ledger.begin(plan["guardId"], request, plan)
        try:
            started = pty.execute_pty(plan, self.fixture.run_docker, self.fixture.ledger, shared.tool)
        except RuntimeError:
            state = pty.Sessions(self.fixture.ledger).read(pty.session_id(plan["guardId"]))
            self.fail("Native PTY startup failure: " + str({key: state.get(key) for key in ("state", "reasonCode", "failureLine")}))
        self.assertEqual(started["status"], "STARTED")
        self.assertEqual(self.fixture.ledger.read(plan["guardId"])["execId"], started["execId"])
        return plan

    def test_actual_tty_stdin_output_and_single_use_input(self):
        plan = self.start(["/bin/bash", "-lc", "test -t 0 && printf 'TTY-YES\\n'; read line; printf 'stdin=%s\\n' \"$line\""])
        mutation = copy.deepcopy(plan)
        mutation["guardId"] = "guard-" + uuid.uuid4().hex
        mutation["action"]["requestId"] = str(uuid.uuid4())
        mutation["descriptor"]["request"]["requestId"] = mutation["action"]["requestId"]
        mutation["descriptor"]["request"].pop("argv")
        mutation["descriptor"]["resultKind"] = "pty/stdin"
        mutation["descriptor"]["pty"] = {"sessionId": pty.session_id(plan["guardId"]), "chars": "hello-native\n",
                                           "outputCursor": 0, "yieldTimeSeconds": 0, "maxOutputTokens": 1000}
        request = {"schema": 1, "method": "tool", "guardId": mutation["guardId"], "action": mutation["action"]}
        self.fixture.ledger.begin(mutation["guardId"], request, mutation)
        try:
            result = pty.mutation(mutation, self.fixture.run_docker, self.fixture.ledger, shared.tool)
        except RuntimeError:
            time.sleep(.1)
            state = pty.Sessions(self.fixture.ledger).read(pty.session_id(plan["guardId"]))
            self.fail("Native PTY failure: " + str({key: state.get(key) for key in ("state", "reasonCode", "failureLine")}))
        self.assertEqual(result["nativeMutationId"], mutation["guardId"])
        self.assertEqual(result["targets"][0]["execId"], self.fixture.ledger.read(plan["guardId"])["execId"])
        with self.assertRaises(FileExistsError):
            self.fixture.ledger.begin(mutation["guardId"], request, mutation)
        end = time.monotonic() + 5
        state = None
        while time.monotonic() < end:
            state = pty.Sessions(self.fixture.ledger).read(pty.session_id(plan["guardId"]))
            if state["state"] == "EXITED":
                break
            time.sleep(.03)
        self.assertEqual(state["state"], "EXITED")
        observed = pty.observe_start(plan, self.fixture.ledger)
        import base64
        output = base64.b64decode(observed["response"]["outputBase64"])
        self.assertIn(b"TTY-YES", output)
        self.assertIn(b"stdin=hello-native", output)
        self.assertEqual(observed["exitCode"], 0)
        self.assertEqual(observed["response"]["outputCursor"], len(output))
        with self.assertRaises(RuntimeError):
            pty.observation(state, plan, len(output) + 1)
        foreign = copy.deepcopy(plan)
        foreign["action"]["attemptId"] = "foreign-attempt"
        with self.assertRaises(RuntimeError):
            pty.Sessions(self.fixture.ledger).scoped(foreign, state["sessionId"])

    def test_timeout_quiets_session_descendants_and_preserves_sandbox(self):
        plan = self.start(["/bin/bash", "-lc", "setsid sleep 60 & sleep 60"], duration=1.5)
        end = time.monotonic() + 5
        while time.monotonic() < end:
            state = pty.Sessions(self.fixture.ledger).read(pty.session_id(plan["guardId"]))
            if state["state"] in {"UNKNOWN", "EXITED"} and state.get("quiet"):
                break
            time.sleep(.03)
        self.assertEqual(state["state"], "UNKNOWN", "actual exit observation: " + str(state.get("exitCode")))
        self.assertTrue(state["quiet"])
        self.assertFalse(Path(state["isolation"]["path"]).exists())
        actual = self.fixture.api("GET", "/containers/" + plan["ownership"]["containerId"] + "/json")["State"]
        self.assertTrue(actual["Running"], str({"actual": actual, "isolation": state["isolation"], "reasonCode": state.get("reasonCode"), "failureLine": state.get("failureLine")}))

    def terminate(self, plan, stop_sandbox=False):
        mutation = copy.deepcopy(plan)
        mutation["guardId"] = "guard-" + uuid.uuid4().hex
        mutation["action"]["requestId"] = str(uuid.uuid4())
        mutation["descriptor"]["request"]["requestId"] = mutation["action"]["requestId"]
        mutation["descriptor"]["request"].pop("argv")
        mutation["descriptor"]["resultKind"] = "pty/terminate"
        mutation["descriptor"]["pty"] = {"stopSandbox": True} if stop_sandbox else {}
        self.fixture.ledger.begin(mutation["guardId"], {"schema": 1, "method": "tool", "guardId": mutation["guardId"], "action": mutation["action"]}, mutation)
        return pty.mutation(mutation, self.fixture.run_docker, self.fixture.ledger, shared.tool)

    def test_ordinary_termination_preserves_sandbox_and_scoped_stop_is_idempotent(self):
        plan = self.start(["/bin/bash", "-lc", "setsid sleep 60 & sleep 60"], duration=10)
        state = pty.Sessions(self.fixture.ledger).read(pty.session_id(plan["guardId"]))
        result = self.terminate(plan)
        self.assertEqual(result["targets"][0]["execId"], state["execId"])
        self.assertFalse(Path(state["isolation"]["path"]).exists())
        self.assertTrue(self.fixture.api("GET", "/containers/" + plan["ownership"]["containerId"] + "/json")["State"]["Running"])
        self.assertEqual(self.terminate(plan, stop_sandbox=True)["targets"], [])
        self.assertFalse(self.fixture.api("GET", "/containers/" + plan["ownership"]["containerId"] + "/json")["State"]["Running"])
        self.assertEqual(self.terminate(plan, stop_sandbox=True)["targets"], [])

    def test_observer_restart_quiets_original_session_without_a_fresh_exec(self):
        plan = self.start(["/bin/bash", "-lc", "setsid sleep 60 & sleep 60"], duration=10)
        state = pty.Sessions(self.fixture.ledger).read(pty.session_id(plan["guardId"]))
        def inspect(current, caller=None):
            identity = shared.tool.owned(current, self.fixture.run_docker)
            return {"state": "PRESENT", "ownership": dict(current["ownership"], containerId=identity)}
        pty.reconcile_sessions(self.fixture.ledger, inspect, self.fixture.run_docker)
        recovered = pty.Sessions(self.fixture.ledger).read(state["sessionId"])
        self.assertEqual(recovered["state"], "UNKNOWN")
        self.assertTrue(recovered["quiet"])
        self.assertEqual(recovered["execId"], state["execId"])
        self.assertFalse(Path(state["isolation"]["path"]).exists())
        self.assertTrue(self.fixture.api("GET", "/containers/" + plan["ownership"]["containerId"] + "/json")["State"]["Running"])

    def test_unavailable_isolation_keeps_guard_pending_and_stops_owned_sandbox(self):
        plan = self.fixture.sandbox(["/bin/bash", "-c", "printf UNAUTHORIZED"], duration=10)
        plan["descriptor"].update(resultKind="pty/start", pty={"tty": True, "yieldTimeSeconds": 0, "maxOutputTokens": 1000})
        self.fixture.ledger.begin(plan["guardId"], {"schema": 1, "method": "tool", "guardId": plan["guardId"], "action": plan["action"]}, plan)
        with patch.object(pty, "isolate_stopped_exec", side_effect=RuntimeError("unavailable host isolation")):
            with self.assertRaises(RuntimeError):
                pty.execute_pty(plan, self.fixture.run_docker, self.fixture.ledger, shared.tool)
        state = pty.Sessions(self.fixture.ledger).read(pty.session_id(plan["guardId"]))
        self.assertEqual(state["state"], "UNKNOWN")
        self.assertTrue(state["quiet"])
        self.assertEqual(state["outputBase64"], "")
        self.assertEqual(self.fixture.ledger.read(plan["guardId"])["state"], "INVOKING")
        self.assertFalse(self.fixture.api("GET", "/containers/" + plan["ownership"]["containerId"] + "/json")["State"]["Running"])


if __name__ == "__main__":
    unittest.main()
