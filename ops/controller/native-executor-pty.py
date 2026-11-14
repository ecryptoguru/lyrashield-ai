#!/usr/bin/python3
"""Bounded, root-owned Docker exec sessions with real TTY and attached stdin."""
import base64
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import socket
import stat
import struct
import time


def require(value):
    if not value:
        raise RuntimeError("Native PTY outcome unavailable")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def session_id(guard):
    return int(hashlib.sha256(guard.encode()).hexdigest()[:13], 16) + 1


class Sessions:
    def __init__(self, ledger):
        self.ledger = ledger

    def path(self, identity, suffix="state"):
        require(type(identity) is int and 1 <= identity <= 4503599627370496)
        return self.ledger.root / (".pty-" + str(identity) + "." + suffix)

    def read(self, identity):
        path = self.path(identity)
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_nlink == 1 and info.st_size <= 2 * 1024 * 1024)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            result = json.loads(os.read(fd, 2 * 1024 * 1024 + 1))
            require(result["sessionId"] == identity)
            return result
        finally:
            os.close(fd)

    def write(self, state, create=False):
        path = self.path(state["sessionId"])
        temporary = path if create else path.with_suffix(".tmp")
        raw = canonical(state).encode()
        require(len(raw) <= 2 * 1024 * 1024)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            require(os.write(fd, raw) == len(raw))
            os.fsync(fd)
        finally:
            os.close(fd)
        if not create:
            os.replace(temporary, path)
        self.ledger.sync()

    def scoped(self, plan, identity):
        state = self.read(identity)
        original = state["plan"]
        require(original["ownership"] == plan["ownership"] and original["network"] == plan["network"]
                and original["image"] == plan["image"]
                and all(original["action"][key] == plan["action"][key]
                        for key in ("operationId", "attemptId", "authorityEpochId"))
                and session_id(state["originalGuardId"]) == identity)
        return state


def observation(state, plan, cursor=0, limit=None):
    output = base64.b64decode(state["outputBase64"], validate=True)
    require(type(cursor) is int and 0 <= cursor <= len(output))
    maximum = plan["descriptor"]["request"]["maxOutputBytes"] if limit is None else limit
    selected = output[cursor:cursor + maximum]
    request = plan["descriptor"]["request"]
    return {"execId": state["execId"], "containerId": plan["ownership"]["containerId"],
        "invocationGuardId": plan["guardId"], "actionChecksum": plan["action"]["actionChecksum"],
        "state": state["state"], "exitCode": state["exitCode"],
        "response": {"binding": request["binding"], "requestId": request["requestId"], "status": "COMPLETED",
            "sessionId": state["sessionId"], "outputBase64": base64.b64encode(selected).decode(),
            "outputCursor": cursor + len(selected), "exitCode": state["exitCode"], "originalTokenCount": None}}


def attached(exec_id, tty):
    stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    stream.settimeout(3)
    stream.connect("/var/run/docker.sock")
    body = canonical({"Detach": False, "Tty": tty}).encode()
    wire = ("POST /v1.41/exec/" + exec_id + "/start HTTP/1.1\r\nHost: localhost\r\n"
            "Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: "
            + str(len(body)) + "\r\n\r\n").encode() + body
    stream.sendall(wire)
    raw = bytearray()
    while b"\r\n\r\n" not in raw:
        chunk = stream.recv(4096)
        require(chunk)
        raw.extend(chunk)
        require(len(raw) <= 65536)
    headers, initial = bytes(raw).split(b"\r\n\r\n", 1)
    require(headers.split(b"\r\n", 1)[0].split()[1] in {b"101", b"200"}
            and b"transfer-encoding: chunked" not in headers.lower())
    stream.setblocking(False)
    return stream, bytearray(initial)


def frame_output(buffer, tty):
    if tty:
        result = bytes(buffer)
        buffer.clear()
        return result
    result = bytearray()
    while len(buffer) >= 8:
        require(buffer[0] in (1, 2) and buffer[1:4] == b"\0\0\0")
        length = struct.unpack(">I", buffer[4:8])[0]
        require(length <= 1048576)
        if len(buffer) < length + 8:
            break
        result.extend(buffer[8:8 + length])
        del buffer[:8 + length]
    return bytes(result)


def process_identity(pid):
    require(type(pid) is int and pid > 1)
    raw = (Path("/proc") / str(pid) / "stat").read_text().rsplit(") ", 1)[1].split()
    groups = (Path("/proc") / str(pid) / "cgroup").read_text().splitlines()
    require(len(groups) == 1 and groups[0].startswith("0::/"))
    return {"startTicks": raw[19], "state": raw[0], "cgroup": groups[0][3:]}


def isolate_stopped_exec(plan, exec_id, tool):
    observed = tool.inspect_exec(exec_id, plan["ownership"]["containerId"])
    end = time.monotonic() + 1
    while type(observed.get("Pid")) is not int or observed["Pid"] <= 1:
        require(time.monotonic() < end)
        time.sleep(.01)
        observed = tool.inspect_exec(exec_id, plan["ownership"]["containerId"])
    pid = observed["Pid"]
    original = process_identity(pid)
    owner = tool.docker_json("GET", "/containers/" + plan["ownership"]["containerId"] + "/json")
    require(owner["Id"] == plan["ownership"]["containerId"] and pid != owner["State"]["Pid"]
            and original["cgroup"] == process_identity(owner["State"]["Pid"])["cgroup"])
    end = time.monotonic() + 1
    while original["state"] not in {"T", "t"}:
        require(time.monotonic() < end)
        time.sleep(.01)
        current = process_identity(pid)
        require(current["startTicks"] == original["startTicks"] and current["cgroup"] == original["cgroup"])
        original = current
    parent = Path("/sys/fs/cgroup") / original["cgroup"].lstrip("/")
    group = parent / ("lyrashield-pty-" + hashlib.sha256(plan["guardId"].encode()).hexdigest())
    require((Path("/sys/fs/cgroup") / "cgroup.controllers").is_file() and not group.exists())
    group.mkdir(mode=0o700)
    (group / "cgroup.procs").write_text(str(pid))
    current = process_identity(pid)
    require(current["startTicks"] == original["startTicks"] and current["state"] in {"T", "t"}
            and current["cgroup"] == original["cgroup"] + "/" + group.name)
    return {"path": str(group), "parent": str(parent), "pid": pid, "startTicks": original["startTicks"]}


def quiet_group(state):
    isolation = state["isolation"]
    group = Path(isolation["path"])
    require(group.parent == Path(isolation["parent"]) and group.name ==
            "lyrashield-pty-" + hashlib.sha256(state["originalGuardId"].encode()).hexdigest()
            and group.is_relative_to(Path("/sys/fs/cgroup")) and not group.is_symlink())
    if not group.exists():
        require(state.get("quiet") is True)
        return
    descriptor = os.open(group / "cgroup.kill", os.O_WRONLY | os.O_NOFOLLOW)
    try:
        require(os.write(descriptor, b"1") == 1)
    finally:
        os.close(descriptor)
    end = time.monotonic() + 1
    while "populated 1" in (group / "cgroup.events").read_text():
        require(time.monotonic() < end)
        time.sleep(.01)
    require(not (group / "cgroup.procs").read_text().strip())
    group.rmdir()


def child(plan, exec_id, run_docker, ledger, tool, ready):
    store = Sessions(ledger)
    identity = session_id(plan["guardId"])
    request, pty = plan["descriptor"]["request"], plan["descriptor"]["pty"]
    state = {"schema": "lyrashield-native-pty/1", "sessionId": identity, "originalGuardId": plan["guardId"],
        "execId": exec_id, "plan": plan, "state": "RUNNING", "exitCode": None, "outputBase64": "", "mutations": {},
        "observerPid": os.getpid(), "observerStartTicks": process_identity(os.getpid())["startTicks"]}
    stream = server = None
    output = bytearray()
    deadline = time.monotonic() + request["timeoutSeconds"]
    try:
        tool.owned(plan, run_docker)
        stream, buffered = attached(exec_id, pty["tty"])
        tool.inspect_exec(exec_id, plan["ownership"]["containerId"])
        state["isolation"] = isolate_stopped_exec(plan, exec_id, tool)
        store.write(state, create=True)
        ledger.record_pty_isolation(plan["guardId"], state["isolation"])
        isolated = process_identity(state["isolation"]["pid"])
        require(isolated["startTicks"] == state["isolation"]["startTicks"] and isolated["state"] in {"T", "t"})
        os.kill(state["isolation"]["pid"], signal.SIGCONT)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(store.path(identity, "sock")))
        os.chmod(store.path(identity, "sock"), 0o600)
        server.listen(4)
        ledger.mark_started(plan["guardId"], exec_id)
        os.write(ready, b"1")
        os.close(ready)
        ready = None
        while time.monotonic() < deadline:
            fresh = frame_output(buffered, pty["tty"])
            output.extend(fresh)
            require(len(output) <= request["maxOutputBytes"])
            if fresh:
                state["outputBase64"] = base64.b64encode(output).decode()
                store.write(state)
            readable = select.select([stream, server], [], [], min(.1, max(.001, deadline-time.monotonic())))[0]
            if stream in readable:
                chunk = stream.recv(65536)
                if chunk:
                    buffered.extend(chunk)
                    continue
                require(not buffered)
                exited = tool.inspect_exec(exec_id, plan["ownership"]["containerId"])
                require(not exited["Running"] and type(exited["ExitCode"]) is int)
                quiet_group(state)
                uncertain = exited["ExitCode"] in {124, 137}
                state.update(state="UNKNOWN" if uncertain else "EXITED",
                             exitCode=None if uncertain else exited["ExitCode"], quiet=True)
                store.write(state)
                break
            if server in readable:
                with server.accept()[0] as connection:
                    connection.settimeout(1)
                    require(struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1] == 0)
                    raw = bytearray()
                    while not raw.endswith(b"\n"):
                        chunk = connection.recv(65536)
                        require(chunk)
                        raw.extend(chunk)
                        require(len(raw) <= 131072)
                    operation = json.loads(raw)
                    guard = operation["guardId"]
                    require(guard not in state["mutations"] and len(state["mutations"]) < 1024
                            and operation["kind"] in {"pty/stdin", "pty/terminate"})
                    state["mutations"][guard] = {"checksum": operation["actionChecksum"], "state": "INVOKING"}
                    store.write(state)  # partial/lost writes never become retryable
                    tool.owned(plan, run_docker)
                    if operation["kind"] == "pty/stdin":
                        require(type(operation["chars"]) is str and len(operation["chars"].encode()) <= 65536)
                        pending = memoryview(operation["chars"].encode())
                        end = min(deadline, time.monotonic() + 1)
                        while pending:
                            require(time.monotonic() < end and select.select([], [stream], [], .05)[1])
                            sent = stream.send(pending)
                            require(sent > 0)
                            pending = pending[sent:]
                    else:
                        quiet_group(state)
                        ended = tool.inspect_exec(exec_id, plan["ownership"]["containerId"])
                        require(not ended["Running"] and type(ended["ExitCode"]) is int)
                        state.update(state="EXITED", exitCode=ended["ExitCode"], quiet=True)
                    state["mutations"][guard]["state"] = "APPLIED"
                    store.write(state)
                    connection.sendall(b'{"applied":true}\n')
                    if operation["kind"] == "pty/terminate":
                        break
        else:
            raise RuntimeError("PTY runtime exceeded")
    except Exception as error:
        traceback = error.__traceback__
        while traceback.tb_next is not None and traceback.tb_next.tb_next is not None:
            traceback = traceback.tb_next
        state.update(state="UNKNOWN", exitCode=None, reasonCode="NATIVE_PTY_" + type(error).__name__, failureLine=traceback.tb_lineno)
        try:
            store.write(state)
        except (OSError, ValueError, KeyError, RuntimeError):
            pass
        try:
            try:
                if state.get("isolation"):
                    quiet_group(state)
                else:
                    tool.stop_owned(plan, run_docker)
            except (OSError, ValueError, KeyError, RuntimeError):
                try:
                    tool.stop_owned(plan, run_docker)
                except RuntimeError:
                    tool.owned(plan, run_docker, running=False)
            state.update(state="UNKNOWN", exitCode=None, quiet=True)
            store.write(state)
        except (OSError, ValueError, KeyError, RuntimeError):
            pass
    finally:
        if ready is not None:
            os.close(ready)
        if stream is not None:
            stream.close()
        if server is not None:
            server.close()
        store.path(identity, "sock").unlink(missing_ok=True)


def execute_pty(plan, run_docker, ledger, tool):
    request = tool.validate_plan(plan)
    pty = plan["descriptor"]["pty"]
    require(type(pty["tty"]) is bool and 0 <= pty["yieldTimeSeconds"] <= 30
            and type(pty["maxOutputTokens"]) is int and 1 <= pty["maxOutputTokens"] <= 100000)
    tool.owned(plan, run_docker)
    require(not Sessions(ledger).path(session_id(plan["guardId"])).exists())
    exec_id = tool.docker_json("POST", "/containers/" + plan["ownership"]["containerId"] + "/exec",
        {"AttachStdin": True, "AttachStdout": True, "AttachStderr": True, "Tty": pty["tty"],
         "Cmd": ["/bin/bash", "--noprofile", "--norc", "-c", 'kill -STOP "$$"; exec "$@"', "lyrashield-pty",
                 "/usr/bin/timeout", "--signal=TERM", "--kill-after=1s", "--", str(request["timeoutSeconds"]) + "s", *request["argv"]],
         "Env": ["BASH_ENV=", "ENV=", "LD_PRELOAD=", "LD_LIBRARY_PATH="],
         "WorkingDir": "/workspace", "User": "1000:1000"})["Id"]
    require(tool.HASH.fullmatch(exec_id))
    ledger.record_exec(plan["guardId"], exec_id)
    read_end, write_end = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(read_end)
            for path in Path("/proc/self/fd").iterdir():
                descriptor = int(path.name)
                if descriptor > 2 and descriptor != write_end:
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
            child(plan, exec_id, run_docker, ledger, tool, write_end)
        finally:
            os._exit(0)
    os.close(write_end)
    try:
        require(select.select([read_end], [], [], 2)[0] and os.read(read_end, 1) == b"1")
        return {"execId": exec_id, "status": "STARTED"}
    except (OSError, RuntimeError):
        try:
            tool.stop_owned(plan, run_docker)
        except RuntimeError:
            tool.owned(plan, run_docker, running=False)
        raise
    finally:
        os.close(read_end)


def send_mutation(store, state, operation):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(2)
        connection.connect(str(store.path(state["sessionId"], "sock")))
        connection.sendall(canonical(operation).encode() + b"\n")
        reply = bytearray()
        while not reply.endswith(b"\n"):
            part = connection.recv(64)
            require(part and len(reply) + len(part) <= 64)
            reply.extend(part)
        require(bytes(reply) == b'{"applied":true}\n')


def mutation(plan, run_docker, ledger, tool):
    tool.validate_plan(plan)
    store, descriptor = Sessions(ledger), plan["descriptor"]
    stop_sandbox = descriptor.get("pty", {}).get("stopSandbox") is True
    already_stopped = False
    if stop_sandbox:
        try:
            tool.owned(plan, run_docker)
            already_stopped = False
        except RuntimeError:
            tool.owned(plan, run_docker, running=False)
            already_stopped = True
    else:
        tool.owned(plan, run_docker)
    kind = descriptor["resultKind"]
    require(kind in {"pty/stdin", "pty/terminate"})
    targets = []
    deadline = time.monotonic() + 6
    if kind == "pty/stdin":
        state = store.scoped(plan, descriptor["pty"]["sessionId"])
        require(state["state"] == "RUNNING")
        targets = [state]
        operation = {"kind": kind, "guardId": plan["guardId"], "actionChecksum": plan["action"]["actionChecksum"], "chars": descriptor["pty"]["chars"]}
        send_mutation(store, state, operation)
    else:
        paths = list(ledger.root.glob(".pty-*.state"))
        require(len(paths) <= 10000)
        for path in paths:
            identity = int(path.name[5:-6])
            state = store.read(identity)
            original = state["plan"]
            if original["ownership"] == plan["ownership"] and not state.get("quiet"):
                targets.append(store.scoped(plan, identity))
        require(len(targets) <= 32)
        for state in targets:
            require(time.monotonic() < deadline)
            if state["state"] == "RUNNING" and not already_stopped:
                send_mutation(store, state, {"kind": "pty/terminate", "guardId": plan["guardId"], "actionChecksum": plan["action"]["actionChecksum"]})
                ended_state = store.scoped(plan, state["sessionId"])
                require(ended_state["quiet"] is True and ended_state["state"] == "EXITED")
            else:
                quiet_group(state)
                ended = tool.inspect_exec(state["execId"], plan["ownership"]["containerId"])
                require(not ended["Running"] and type(ended["ExitCode"]) is int)
                state.update(state="EXITED", exitCode=ended["ExitCode"], quiet=True)
                store.write(state)
        if stop_sandbox and not already_stopped:
            tool.stop_owned(plan, run_docker)
    native_targets = [{"execId": state["execId"], "originalGuardId": state["originalGuardId"], "sessionId": state["sessionId"]} for state in targets]
    receipt = {"schema": "lyrashield-native-pty-mutation/1", "guardId": plan["guardId"],
        "actionChecksum": plan["action"]["actionChecksum"], "kind": kind, "targets": native_targets}
    checksum = hashlib.sha256(canonical(receipt).encode()).hexdigest()
    result = {"status": "MUTATED", "nativeMutationId": plan["guardId"], "targets": native_targets, "nativeReceiptSha256": checksum}
    ledger.complete(plan["guardId"], result)
    return result


def observe_start(plan, ledger):
    store = Sessions(ledger)
    identity = session_id(plan["guardId"])
    state = store.scoped(plan, identity)
    require(state["state"] in {"RUNNING", "EXITED"})
    return observation(state, plan)


def observe_mutation(plan, ledger):
    entry = ledger.read(plan["guardId"])
    result = entry["result"]
    require(result["status"] == "MUTATED" and result["nativeMutationId"] == plan["guardId"])
    request = plan["descriptor"]["request"]
    if plan["descriptor"]["resultKind"] == "pty/stdin":
        state = Sessions(ledger).scoped(plan, plan["descriptor"]["pty"]["sessionId"])
        require(state["state"] in {"RUNNING", "EXITED"})
        response = observation(state, plan, plan["descriptor"]["pty"]["outputCursor"])["response"]
    else:
        response = {"binding": request["binding"], "requestId": request["requestId"], "status": "COMPLETED",
                    "exitCode": 0, "terminatedCount": len(result["targets"])}
    return {"nativeMutationId": result["nativeMutationId"], "targets": result["targets"],
            "nativeReceiptSha256": result["nativeReceiptSha256"], "response": response}


def reconcile_sessions(ledger, inspect_owned, run_docker):
    store = Sessions(ledger)
    paths = list(ledger.root.glob(".pty-*.state"))
    require(len(paths) <= 10000)
    for path in paths:
        state = store.read(int(path.name[5:-6]))
        if state.get("quiet"):
            continue
        original = ledger.read(state["originalGuardId"])
        require(original["request"]["method"] == "tool" and original["plan"] == state["plan"]
                and original.get("ptyIsolation") == state.get("isolation"))
        observed = inspect_owned(original["plan"], original["plan"]["ownership"])
        # Only the original root observer process can be stopped. Reused PIDs
        # are never signalled; the isolated cgroup still identifies descendants.
        pid = state.get("observerPid")
        if pid:
            try:
                current = process_identity(pid)
                if current["startTicks"] == state["observerStartTicks"]:
                    os.kill(pid, signal.SIGKILL)
                    end = time.monotonic() + 1
                    while (Path("/proc") / str(pid)).exists():
                        current = process_identity(pid)
                        if current["startTicks"] != state["observerStartTicks"] or current["state"] == "Z":
                            break
                        require(time.monotonic() < end)
                        time.sleep(.01)
            except ProcessLookupError:
                pass
            except FileNotFoundError:
                pass
        isolated_quiet = False
        if state.get("isolation") and Path(state["isolation"]["path"]).exists():
            try:
                quiet_group(state)
                isolated_quiet = True
            except (OSError, ValueError, KeyError, RuntimeError):
                pass
        if not isolated_quiet and observed["state"] == "PRESENT":
            run_docker(["container", "rm", "--force", observed["ownership"]["containerId"]])
            require(inspect_owned(original["plan"])["state"] == "ABSENT")
        temporary = path.with_suffix(".tmp")
        if temporary.exists():
            info = temporary.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1)
            temporary.unlink()
        state.update(state="UNKNOWN", exitCode=None, quiet=True, reasonCode="NATIVE_OBSERVER_STOPPED")
        store.write(state)
