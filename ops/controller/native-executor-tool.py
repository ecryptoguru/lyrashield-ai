#!/usr/bin/env python3
"""The root native service invokes one exact, durably identified sandbox exec."""
import base64
import http.client
import hashlib
import json
import math
import os
import re
import select
import socket
import struct
import subprocess
import time

DOCKER_SOCKET = "/var/run/docker.sock"
HASH = re.compile(r"[a-f0-9]{64}")
OWN = re.compile(r"own_[a-f0-9]{40}")


def require(value):
    if not value:
        raise RuntimeError("Native sandbox execution is unavailable")


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, timeout=3):
        super().__init__("localhost", timeout=timeout)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(DOCKER_SOCKET)


def docker_json(method, path, body=None):
    connection = DockerConnection()
    try:
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        connection.request(method, "/v1.41" + path, payload,
                           {"Content-Type": "application/json"} if payload else {})
        response = connection.getresponse()
        require(response.status in (200, 201))
        raw = response.read(65537)
        require(len(raw) <= 65536)
        return json.loads(raw)
    finally:
        connection.close()


def owned(plan, run_docker, running=True):
    identity = plan["ownership"]["containerId"]
    require(HASH.fullmatch(identity) and OWN.fullmatch(plan["ownership"]["ownershipId"]))
    rows = json.loads(run_docker(["container", "inspect", identity]))
    require(len(rows) == 1)
    row = rows[0]
    labels = row["Config"].get("Labels") or {}
    require(row["Id"] == identity and labels.get("lyrashield.supervisor.ownership") == plan["ownership"]["ownershipId"]
            and row["Name"] == "/lyrashield-supervisor-" + plan["ownership"]["ownershipId"][4:36]
            and labels.get("lyrashield.supervisor.attempt") == plan["action"]["attemptId"]
            and row["Config"]["Image"] == plan["image"]
            and row["HostConfig"]["NetworkMode"] == plan["network"]
            and row["HostConfig"]["Privileged"] is False
            and row["HostConfig"]["ReadonlyRootfs"] is True
            and set(row["HostConfig"].get("CapDrop") or []) == {"ALL"}
            and "no-new-privileges" in (row["HostConfig"].get("SecurityOpt") or [])
            and row["State"]["Running"] is running)
    return identity


def stop_owned(plan, run_docker):
    identity = owned(plan, run_docker)
    run_docker(["container", "stop", "--time", "1", identity], timeout=4)
    owned(plan, run_docker, running=False)


def validate_plan(plan):
    descriptor = plan["descriptor"]
    request = descriptor["request"]
    action = plan["action"]
    require(descriptor["schema"] == "lyrashield-sandbox-tool-exec/1"
            and descriptor["ownership"] == plan["ownership"]
            and descriptor["workspaceRoot"] == "/workspace" and request["cwd"] == "/workspace"
            and request["user"] == "pentester" and action["phase"] == "SANDBOX_TOOL"
            and action["executorKey"] == "sandbox" and action["requestId"] == request["requestId"]
            and request["binding"]["sandboxHandle"] == plan["ownership"]["ownershipId"]
            and all(request["binding"][key] == action[key] for key in ("operationId", "attemptId", "authorityEpochId")))
    argv = request.get("argv")
    mutation = descriptor.get("resultKind") in {"pty/stdin", "pty/terminate"}
    duration = request["timeoutSeconds"]
    limit = request["maxOutputBytes"]
    require(("argv" not in request if mutation else isinstance(argv, list) and 1 <= len(argv) <= 256
            and all(isinstance(arg, str) and 1 <= len(arg) <= 8192 and "\0" not in arg for arg in argv))
            and isinstance(duration, (float, int)) and not isinstance(duration, bool)
            and math.isfinite(duration) and 0 < duration <= 300
            and isinstance(limit, int) and not isinstance(limit, bool) and 1 <= limit <= 1048576)
    return request


def inspect_exec(exec_id, container_id):
    result = docker_json("GET", "/exec/" + exec_id + "/json")
    require(result["ID"] == exec_id and result["ContainerID"] == container_id
            and isinstance(result["Running"], bool))
    return result


def terminal(plan, exec_id, run_docker, ledger, ready):
    request = validate_plan(plan)
    connection = DockerConnection(timeout=request["timeoutSeconds"] + 1)
    stdout, stderr = bytearray(), bytearray()
    deadline = time.monotonic() + request["timeoutSeconds"]
    reason = "NATIVE_OUTCOME_UNKNOWN"
    try:
        owned(plan, run_docker)
        body = json.dumps({"Detach": False, "Tty": False}, separators=(",", ":")).encode()
        connection.request("POST", "/v1.41/exec/" + exec_id + "/start", body,
                           {"Content-Type": "application/json"})
        response = connection.getresponse()
        require(response.status == 200)
        observed = inspect_exec(exec_id, plan["ownership"]["containerId"])
        require(observed["Running"] or isinstance(observed["ExitCode"], int))
        ledger.mark_started(plan["guardId"], exec_id)
        os.write(ready, b"1")
        os.close(ready)
        ready = None
        for _ in range(100000):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                reason = "TIMEOUT"
                raise TimeoutError()
            header = response.read(8)
            if not header:
                break
            require(len(header) == 8 and header[0] in (1, 2) and header[1:4] == b"\0\0\0")
            count = struct.unpack(">I", header[4:])[0]
            if len(stdout) + len(stderr) + count > request["maxOutputBytes"]:
                reason = "OUTPUT_LIMIT_EXCEEDED"
                raise RuntimeError()
            output = response.read(count)
            require(len(output) == count)
            (stdout if header[0] == 1 else stderr).extend(output)
        else:
            raise RuntimeError()
        observed = inspect_exec(exec_id, plan["ownership"]["containerId"])
        require(observed["Running"] is False and isinstance(observed["ExitCode"], int)
                and 0 <= observed["ExitCode"] <= 255)
        if observed["ExitCode"] in (124, 137) or time.monotonic() >= deadline:
            reason = "TIMEOUT"
            raise TimeoutError()
        result = {
            "execId": exec_id, "containerId": plan["ownership"]["containerId"],
            "invocationGuardId": plan["guardId"], "actionChecksum": plan["action"]["actionChecksum"],
            "state": "EXITED", "exitCode": observed["ExitCode"],
            "response": {"binding": request["binding"], "requestId": request["requestId"],
                         "status": "COMPLETED", "exitCode": observed["ExitCode"],
                         "stdoutBase64": base64.b64encode(stdout).decode(),
                         "stderrBase64": base64.b64encode(stderr).decode()},
        }
        kind = plan["descriptor"].get("resultKind")
        if kind == "state/renew":
            require(request["argv"] == ["/usr/bin/true"] and observed["ExitCode"] == 0 and not stdout and not stderr)
            state = plan["stateResult"]
            require(isinstance(state, dict) and set(state) == {"grant", "runtimeAuthority", "running"}
                    and state["running"] is True)
            result["response"] = {"binding": request["binding"], "requestId": request["requestId"],
                                  "status": "COMPLETED", "exitCode": 0, **state}
            require(len(json.dumps(result["response"], separators=(",", ":")).encode()) <= request["maxOutputBytes"])
        elif kind:
            require(kind in ("files/read", "files/write", "workspace/persist", "workspace/hydrate")
                    and observed["ExitCode"] == 0 and not stderr)
            fields = json.loads(stdout)
            expected = {"dataBase64", "sha256"} if kind == "files/read" else (
                {"archiveBase64", "sha256"} if kind == "workspace/persist" else {"sha256"})
            require(isinstance(fields, dict) and set(fields) == expected
                    and HASH.fullmatch(fields["sha256"]))
            encoded = fields.get("dataBase64", fields.get("archiveBase64"))
            if encoded is not None:
                require(isinstance(encoded, str) and len(encoded) <= 699052)
                content = base64.b64decode(encoded, validate=True)
                require(len(content) <= 524288 and base64.b64encode(content).decode() == encoded
                        and hashlib.sha256(content).hexdigest() == fields["sha256"])
            result["response"] = {"binding": request["binding"], "requestId": request["requestId"],
                                  "status": "COMPLETED", "exitCode": 0, **fields}
        ledger.complete(plan["guardId"], result)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, http.client.HTTPException, subprocess.SubprocessError) as error:
        if isinstance(error, TimeoutError):
            reason = "TIMEOUT"
        quiet = False
        try:
            stop_owned(plan, run_docker)
            quiet = True
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError):
            pass
        ledger.complete(plan["guardId"], {
            "execId": exec_id, "containerId": plan["ownership"]["containerId"],
            "invocationGuardId": plan["guardId"], "actionChecksum": plan["action"]["actionChecksum"],
            "state": "UNKNOWN", "reasonCode": reason, "quiet": quiet,
        })
    finally:
        connection.close()
        if ready is not None:
            os.close(ready)


def execute_tool(plan, run_docker, ledger):
    request = validate_plan(plan)
    container_id = owned(plan, run_docker)
    # timeout survives loss of the host observer; the observer also stops the
    # entire owned sandbox for timeout/overflow to terminate detached descendants.
    argv = ["/usr/bin/timeout", "--signal=TERM", "--kill-after=1s", "--",
            str(request["timeoutSeconds"]) + "s", *request["argv"]]
    created = docker_json("POST", "/containers/" + container_id + "/exec", {
        "AttachStdin": False, "AttachStdout": True, "AttachStderr": True,
        "Tty": False, "Cmd": argv, "User": "1000:1000", "WorkingDir": request["cwd"],
    })
    exec_id = created["Id"]
    require(HASH.fullmatch(exec_id))
    ledger.record_exec(plan["guardId"], exec_id)
    read_end, write_end = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(read_end)
            # A bounded child must not retain the listening socket or service lock.
            for name in os.listdir("/proc/self/fd"):
                descriptor = int(name)
                if descriptor > 2 and descriptor != write_end:
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
            terminal(plan, exec_id, run_docker, ledger, write_end)
        finally:
            os._exit(0)
    os.close(write_end)
    try:
        require(select.select([read_end], [], [], 2)[0] and os.read(read_end, 1) == b"1")
        return {"execId": exec_id, "status": "STARTED"}
    except (OSError, RuntimeError):
        stop_owned(plan, run_docker)
        raise
    finally:
        os.close(read_end)
