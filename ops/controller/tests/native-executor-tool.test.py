import base64
import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid


def load(name):
    source = Path(__file__).resolve().parents[1] / (name + ".py")
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = load("native-executor-tool")


def plan(container="c" * 64, image="fixture@sha256:" + "a" * 64, argv=None, duration=2, limit=1024):
    ownership = {"kind": "container", "executorKey": "sandbox", "ownershipId": "own_" + "b" * 40,
                 "containerId": container}
    request_id = str(uuid.uuid4())
    action = {"phase": "SANDBOX_TOOL", "executorKey": "sandbox", "operationId": "operation-1",
              "attemptId": "attempt-1", "authorityEpochId": "epoch-1", "requestId": request_id,
              "actionChecksum": "d" * 64}
    request = {"binding": {"operationId": "operation-1", "attemptId": "attempt-1",
                           "authorityEpochId": "epoch-1", "sandboxHandle": ownership["ownershipId"]},
               "requestId": request_id, "commandId": request_id, "argv": argv or ["/bin/true"],
               "cwd": "/workspace", "user": "pentester", "timeoutSeconds": duration, "maxOutputBytes": limit}
    return {"schema": 1, "method": "tool", "guardId": "guard-" + uuid.uuid4().hex,
            "action": action, "ownership": ownership, "image": image, "network": "none",
            "descriptor": {"schema": "lyrashield-sandbox-tool-exec/1", "request": request,
                           "workspaceRoot": "/workspace", "ownership": ownership}}


class MemoryLedger:
    def __init__(self):
        self.result = None
        self.started = False

    def mark_started(self, guard, exec_id):
        self.started = True

    def complete(self, guard, result):
        self.result = result


class Connection:
    def __init__(self, response):
        self.response = response

    def request(self, *args):
        pass

    def getresponse(self):
        return self.response

    def close(self):
        pass


class Response(io.BytesIO):
    status = 200


def frame(stream, value):
    return bytes([stream, 0, 0, 0]) + struct.pack(">I", len(value)) + value


class TerminalTests(unittest.TestCase):
    def observe(self, current, response, exited=0):
        ledger = MemoryLedger()
        read_end, write_end = os.pipe()
        initial = {"Running": True, "ExitCode": 0}
        complete = {"Running": False, "ExitCode": exited}
        try:
            with patch.object(tool, "DockerConnection", return_value=Connection(response)), \
                 patch.object(tool, "owned", return_value=current["ownership"]["containerId"]), \
                 patch.object(tool, "inspect_exec", side_effect=[initial, complete]), \
                 patch.object(tool, "stop_owned") as stop:
                tool.terminal(current, "e" * 64, lambda *args, **kw: b"", ledger, write_end)
            return ledger, stop
        finally:
            os.close(read_end)

    def test_retains_exact_stdout_and_stderr_at_the_combined_limit(self):
        ledger, stop = self.observe(plan(limit=4), Response(frame(1, b"abc") + frame(2, b"d")))
        self.assertEqual(ledger.result["state"], "EXITED")
        self.assertEqual(base64.b64decode(ledger.result["response"]["stdoutBase64"]), b"abc")
        self.assertEqual(base64.b64decode(ledger.result["response"]["stderrBase64"]), b"d")
        self.assertTrue(ledger.started)
        stop.assert_not_called()

    def test_overflow_stops_only_the_owned_sandbox_and_retains_unknown(self):
        ledger, stop = self.observe(plan(limit=3), Response(frame(1, b"abcd")))
        self.assertEqual(ledger.result["state"], "UNKNOWN")
        self.assertEqual(ledger.result["reasonCode"], "OUTPUT_LIMIT_EXCEEDED")
        self.assertTrue(ledger.result["quiet"])
        self.assertNotIn("response", ledger.result)
        stop.assert_called_once()

    def test_timeout_stops_the_owned_sandbox_without_successful_output(self):
        ledger, stop = self.observe(plan(), Response(), exited=124)
        self.assertEqual(ledger.result["reasonCode"], "TIMEOUT")
        self.assertEqual(ledger.result["state"], "UNKNOWN")
        stop.assert_called_once()

    def test_foreign_handle_and_invalid_bounds_are_rejected(self):
        for field, value in [("maxOutputBytes", 0), ("timeoutSeconds", float("inf")),
                             ("cwd", "/"), ("user", "root")]:
            current = plan()
            current["descriptor"]["request"][field] = value
            with self.assertRaises(RuntimeError):
                tool.validate_plan(current)
        current = plan()
        current["descriptor"]["request"]["binding"]["sandboxHandle"] = "other"
        with self.assertRaises(RuntimeError):
            tool.validate_plan(current)

    def test_state_renewal_requires_real_fixed_noop_and_retains_only_root_signed_state(self):
        current = plan(argv=["/usr/bin/true"], limit=4096)
        current["descriptor"]["resultKind"] = "state/renew"
        current["stateResult"] = {"running": True, "grant": {"raw": "checked-grant", "result": {}},
                                  "runtimeAuthority": {"raw": "checked-authority", "result": {}}}
        ledger, stop = self.observe(current, Response())
        self.assertEqual(ledger.result["state"], "EXITED")
        self.assertEqual(ledger.result["response"]["grant"], current["stateResult"]["grant"])
        self.assertEqual(ledger.result["response"]["binding"], current["descriptor"]["request"]["binding"])
        stop.assert_not_called()
        ledger, stop = self.observe(current, Response(frame(1, b"caller state")))
        self.assertEqual(ledger.result["state"], "UNKNOWN")
        self.assertNotIn("response", ledger.result)
        stop.assert_called_once()
        current["descriptor"]["request"]["maxOutputBytes"] = 1
        ledger, stop = self.observe(current, Response())
        self.assertEqual(ledger.result["state"], "UNKNOWN")
        self.assertNotIn("response", ledger.result)
        stop.assert_called_once()

    def test_file_response_is_bound_and_checksum_verified_before_retention(self):
        current = plan()
        current["descriptor"]["resultKind"] = "files/read"
        data = b"source fixture"
        fields = {"dataBase64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()}
        ledger, stop = self.observe(current, Response(frame(1, json.dumps(fields).encode())))
        self.assertEqual(ledger.result["response"]["dataBase64"], fields["dataBase64"])
        self.assertEqual(ledger.result["response"]["binding"], current["descriptor"]["request"]["binding"])
        stop.assert_not_called()
        fields["sha256"] = "f" * 64
        ledger, stop = self.observe(current, Response(frame(1, json.dumps(fields).encode())))
        self.assertEqual(ledger.result["state"], "UNKNOWN")
        self.assertNotIn("response", ledger.result)
        stop.assert_called_once()


@unittest.skipUnless(os.getenv("LYRA_NATIVE_TOOL_DOCKER_TEST") == "1", "needs disposable Linux Docker")
class DockerTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.native = load("native-executor")
        self.ledger = self.native.NativeLedger(Path(self.root.name))
        self.containers = []
        self.image = os.environ["LYRA_NATIVE_TOOL_TEST_IMAGE"]

    def api(self, method, path, body=None):
        connection = tool.DockerConnection()
        try:
            raw = None if body is None else json.dumps(body).encode()
            connection.request(method, "/v1.41" + path, raw,
                               {"Content-Type": "application/json"} if raw else {})
            response = connection.getresponse()
            data = response.read(262145)
            self.assertIn(response.status, (200, 201, 204, 304))
            self.assertLessEqual(len(data), 262144)
            return None if not data else json.loads(data)
        finally:
            connection.close()

    def sandbox(self, argv, duration=2, limit=1024):
        current = plan(image=self.image, argv=argv, duration=duration, limit=limit)
        current["ownership"]["ownershipId"] = "own_" + uuid.uuid4().hex + uuid.uuid4().hex[:8]
        current["descriptor"]["request"]["binding"]["sandboxHandle"] = current["ownership"]["ownershipId"]
        created = self.api("POST", "/containers/create?name=lyrashield-supervisor-" + current["ownership"]["ownershipId"][4:36], {
            "Image": self.image, "Cmd": ["python", "-c", "import time; time.sleep(600)"],
            "User": "1000:1000", "WorkingDir": "/workspace",
            "Labels": {"lyrashield.supervisor.ownership": current["ownership"]["ownershipId"],
                       "lyrashield.supervisor.attempt": current["action"]["attemptId"]},
            "HostConfig": {"ReadonlyRootfs": True, "Privileged": False, "NetworkMode": "none",
                           "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges"], "PidsLimit": 64,
                           "Tmpfs": {"/workspace": "uid=1000,gid=1000,mode=0700,size=4m"}},
        })
        identity = created["Id"]
        self.containers.append(identity)
        current["ownership"]["containerId"] = identity
        self.api("POST", "/containers/" + identity + "/start")
        return current

    def run_docker(self, args, **kw):
        if args[:2] == ["container", "inspect"]:
            return json.dumps([self.api("GET", "/containers/" + args[2] + "/json")]).encode()
        if args[:2] == ["container", "stop"]:
            self.api("POST", "/containers/" + args[-1] + "/stop?t=1")
            return b""
        raise AssertionError("Unapproved fixture Docker operation")

    def run_tool(self, current):
        guard = current["guardId"]
        request = {"schema": 1, "method": "tool", "guardId": guard, "action": current["action"]}
        self.ledger.begin(guard, request, current)
        acknowledged = tool.execute_tool(current, self.run_docker, self.ledger)
        self.assertEqual(acknowledged["status"], "STARTED")
        end = time.monotonic() + 8
        while time.monotonic() < end:
            entry = self.ledger.read(guard)
            if entry["state"] == "OBSERVED":
                os.waitpid(-1, os.WNOHANG)
                return entry
            time.sleep(0.03)
        self.fail("Missing native terminal evidence")

    def test_exact_output_and_single_use_ledger(self):
        current = self.sandbox(["python", "-c", "import sys; print('hello'); print('error',file=sys.stderr)"])
        entry = self.run_tool(current)
        self.assertEqual(entry["result"]["state"], "EXITED")
        self.assertEqual(base64.b64decode(entry["result"]["response"]["stdoutBase64"]), b"hello\n")
        self.assertEqual(base64.b64decode(entry["result"]["response"]["stderrBase64"]), b"error\n")
        with self.assertRaises(FileExistsError):
            self.ledger.begin(current["guardId"], entry["request"], current)
        self.assertEqual(self.ledger.read(current["guardId"]), entry)

    def test_timeout_terminates_detached_descendants_by_stopping_the_sandbox(self):
        current = self.sandbox(["python", "-c", "import subprocess,time; subprocess.Popen(['/usr/bin/setsid','/bin/sleep','60']); time.sleep(60)"], duration=0.3)
        entry = self.run_tool(current)
        self.assertEqual(entry["result"]["state"], "UNKNOWN")
        self.assertEqual(entry["result"]["reasonCode"], "TIMEOUT")
        self.assertTrue(entry["result"]["quiet"])
        self.assertFalse(self.api("GET", "/containers/" + current["ownership"]["containerId"] + "/json")["State"]["Running"])

    def test_overflow_stops_the_exact_sandbox(self):
        current = self.sandbox(["python", "-c", "print('x'*100000)"], limit=1024)
        entry = self.run_tool(current)
        self.assertEqual(entry["result"]["reasonCode"], "OUTPUT_LIMIT_EXCEEDED")
        self.assertTrue(entry["result"]["quiet"])
        self.assertNotIn("response", entry["result"])

    def test_foreign_ownership_never_creates_an_exec(self):
        current = self.sandbox(["/bin/true"])
        current["action"]["attemptId"] = "foreign-attempt"
        current["descriptor"]["request"]["binding"]["attemptId"] = "foreign-attempt"
        self.ledger.begin(current["guardId"], {"method": "tool"}, current)
        with self.assertRaises(RuntimeError):
            tool.execute_tool(current, self.run_docker, self.ledger)
        self.assertEqual(self.ledger.read(current["guardId"])["state"], "INVOKING")

    def tearDown(self):
        for identity in self.containers:
            self.api("DELETE", "/containers/" + identity + "?force=1")
        self.root.cleanup()


if __name__ == "__main__":
    unittest.main()
