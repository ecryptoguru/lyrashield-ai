#!/usr/bin/python3
"""Root-only, action-bound native operations. No client Docker/shell interface."""
import fcntl
from contextlib import contextmanager
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time

ROOT = Path("/opt/lyrashield/runtime-control")
SOCKET = Path("/run/lyrashield/control/native-executor.sock")
LEDGER = Path("/var/lib/lyrashield/native-executor")
ENV = Path("/etc/lyrashield/native-executor.env")
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$")
OWN = re.compile(r"^own_[a-f0-9]{40}$")
CONTAINER = re.compile(r"^[a-f0-9]{64}$")
MAX_REQUEST = 65536
MAX_PLAN = 512 * 1024
MAX_RESULT = 2 * 1024 * 1024
ENV_NAMES = (
    "LYRASHIELD_SCAN_EXECUTION_DATABASE_URL", "LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON",
    "LYRASHIELD_SUPERVISOR_SIGNING_SECRET", "LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET",
    "LYRASHIELD_SUPERVISOR_CONTROL_TOKEN", "LYRASHIELD_SUPERVISOR_INSTANCE_ID",
    "LYRASHIELD_AUTHORITY_EPOCH_ID", "LYRASHIELD_PRODUCT_REVISION",
    "LYRASHIELD_RUNTIME_POLICY_DIGEST", "LYRASHIELD_PROVIDER_GATEWAY_URL",
    "LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN",
)
ENGINE_ENV_NAMES = {
    "LYRASHIELD_SUPERVISOR_TOOL_URL", "LYRASHIELD_SUPERVISOR_TOOL_TOKEN",
    "LYRASHIELD_SUPERVISOR_ATTEMPT_ID", "LYRASHIELD_SUPERVISOR_OPERATION_ID",
    "LYRASHIELD_SUPERVISOR_AUTHORITY_EPOCH_ID", "LYRASHIELD_SUPERVISOR_SANDBOX_HANDLE",
    "LYRASHIELD_SUPERVISOR_RUNTIME_AUTHORITY", "LYRASHIELD_SUPERVISOR_MANIFEST_INPUT",
}


def require(value):
    if not value:
        raise RuntimeError("Protected native execution unavailable")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def protected(path, directory=False, private=False):
    info = path.lstat()
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == 0 and not info.st_mode & 0o022)
    if private:
        require(stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o400))


def module(name):
    path = ROOT / (name + ".py")
    protected(path)
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def run_docker(args, *, timeout=6, input=None, env=None, max_output=262144):
    require(isinstance(args, list) and all(isinstance(item, str) and "\0" not in item for item in args))
    child_env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"}
    if env:
        require(set(env) <= set(ENV_NAMES) | {"LLM_API_KEY"})
        child_env.update(env)
    process = subprocess.Popen(["/usr/bin/docker", *args], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env=child_env, start_new_session=True)
    try:
        if input:
            process.stdin.write(input)
        process.stdin.close()
        output = bytearray()
        end = time.monotonic() + min(timeout, 8)
        with selectors.DefaultSelector() as events:
            events.register(process.stdout, selectors.EVENT_READ)
            while events.get_map():
                remaining = end - time.monotonic()
                require(remaining > 0)
                for key, _ in events.select(remaining):
                    chunk = os.read(key.fd, min(65536, max_output + 1 - len(output)))
                    if not chunk:
                        events.unregister(key.fileobj)
                    else:
                        output.extend(chunk)
                        require(len(output) <= max_output)
        require(process.wait(timeout=max(0.01, end - time.monotonic())) == 0)
        return bytes(output)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, 9)
            process.wait()


class NativeLedger:
    def __init__(self, root=LEDGER):
        self.root = root
        protected(root, directory=True, private=True)

    def path(self, guard):
        require(isinstance(guard, str) and ID.fullmatch(guard))
        return self.root / (hashlib.sha256(guard.encode()).hexdigest() + ".json")

    def read(self, guard):
        path = self.path(guard)
        protected(path)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            require(info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= MAX_RESULT + MAX_PLAN)
            raw = os.read(descriptor, MAX_RESULT + MAX_PLAN + 1)
            result = json.loads(raw)
            require(result["guardId"] == guard)
            return result
        finally:
            os.close(descriptor)

    def begin(self, guard, request, plan):
        entry = {"schema": 1, "guardId": guard, "request": request, "plan": plan, "state": "INVOKING"}
        raw = canonical(entry).encode()
        require(len(raw) <= MAX_PLAN)
        descriptor = os.open(self.path(guard), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            require(os.write(descriptor, raw) == len(raw))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        self.sync()
        return entry

    def complete(self, guard, result):
        with self.lock(guard):
            entry = self.read(guard)
            require(entry["state"] in {"INVOKING", "RUNNING"})
            entry.update(state="OBSERVED", result=result,
                         receiptSha256=hashlib.sha256(canonical(result).encode()).hexdigest())
            self.replace(guard, entry)

    def retain_engine_grant(self, guard, grant, authority, ownership, manifest):
        with self.lock(guard):
            entry = self.read(guard)
            require(entry["state"] == "INVOKING" and entry["request"]["method"] == "create"
                    and entry["plan"]["ownership"]["executorKey"] == "engine"
                    and "sandboxGrant" not in entry["plan"])
            entry["plan"].update(sandboxGrant=grant, sandboxRuntimeAuthority=authority,
                                 expectedSandboxOwnership=ownership, manifestInputJson=manifest)
            self.replace(guard, entry)

    def record_manifest(self, guard, path):
        with self.lock(guard):
            entry = self.read(guard)
            require(entry["state"] == "INVOKING" and entry["request"]["method"] == "create"
                    and entry["plan"]["ownership"]["executorKey"] == "engine" and "manifestCidPath" not in entry)
            entry["manifestCidPath"] = path
            self.replace(guard, entry)

    def record_pty_isolation(self, guard, isolation):
        with self.lock(guard):
            entry = self.read(guard)
            require(entry["state"] == "INVOKING" and entry["request"]["method"] == "tool"
                    and entry["plan"]["descriptor"].get("resultKind") == "pty/start" and "ptyIsolation" not in entry)
            entry["ptyIsolation"] = isolation
            self.replace(guard, entry)

    def retain_output_path(self, guard, path):
        with self.lock(guard):
            entry = self.read(guard)
            require(entry["state"] == "INVOKING" and entry["request"]["method"] == "create"
                    and entry["plan"]["ownership"]["executorKey"] == "engine" and "outputPath" not in entry["plan"])
            require(Path(path) == self.root / "output" / hashlib.sha256(entry["plan"]["ownership"]["ownershipId"].encode()).hexdigest())
            entry["plan"]["outputPath"] = path
            self.replace(guard, entry)

    def retain_result_capture(self, guard, capture):
        with self.lock(guard):
            entry = self.read(guard)
            require(entry["request"]["method"] == "create" and entry["plan"]["ownership"]["executorKey"] == "engine")
            require(not entry.get("resultCapture") or entry["resultCapture"] == capture)
            entry["resultCapture"] = capture
            self.replace(guard, entry)

    def retain_tool_state(self, guard, result):
        with self.lock(guard):
            entry = self.read(guard)
            require(entry["state"] == "INVOKING" and entry["request"]["method"] == "tool"
                    and entry["plan"]["descriptor"].get("resultKind") == "state/renew")
            entry["plan"]["stateResult"] = result
            self.replace(guard, entry)

    def retain_terminal_observation(self, guard, result):
        with self.lock(guard):
            entry = self.read(guard)
            require(entry["request"]["method"] == "tool" and entry["plan"]["descriptor"].get("resultKind", "").startswith("pty/"))
            if "terminalObservation" not in entry:
                entry["terminalObservation"] = result
                if entry["state"] != "OBSERVED":
                    entry.update(state="OBSERVED", result=result)
                self.replace(guard, entry)
            return entry["terminalObservation"]

    def engine_for_sandbox(self, plan):
        matches = []
        paths = list(self.root.glob("*.json"))
        require(len(paths) <= 10000)
        for path in paths:
            protected(path)
            require(path.stat().st_size <= MAX_RESULT + MAX_PLAN)
            entry = self.read(json.loads(path.read_bytes())["guardId"])
            candidate = entry["plan"]
            if entry["request"]["method"] == "create" and candidate["ownership"]["executorKey"] == "engine" \
                    and candidate.get("expectedSandboxOwnership") == plan["ownership"] \
                    and candidate["action"]["operationId"] == plan["action"]["operationId"] \
                    and candidate["action"]["attemptId"] == plan["action"]["attemptId"] \
                    and candidate["epochId"] == plan["epochId"] and candidate["sourceRevision"] == plan["sourceRevision"]:
                require(entry["state"] == "OBSERVED" and isinstance(candidate.get("manifestInputJson"), str))
                matches.append(entry)
        require(len(matches) == 1)
        return matches[0]

    def sandbox_for_engine(self, plan):
        matches = []
        paths = list(self.root.glob("*.json"))
        require(len(paths) <= 10000)
        for path in paths:
            protected(path)
            require(path.stat().st_size <= MAX_RESULT + MAX_PLAN)
            entry = self.read(json.loads(path.read_bytes())["guardId"])
            candidate = entry["plan"]
            if entry["request"]["method"] == "create" and candidate["ownership"]["executorKey"] == "sandbox" \
                    and candidate["action"]["operationId"] == plan["action"]["operationId"] \
                    and candidate["action"]["attemptId"] == plan["action"]["attemptId"] \
                    and candidate["epochId"] == plan["epochId"] and candidate["sourceRevision"] == plan["sourceRevision"]:
                require(entry["state"] == "OBSERVED")
                matches.append(entry)
        require(len(matches) == 1)
        return matches[0]

    def record_exec(self, guard, exec_id):
        require(isinstance(exec_id, str) and CONTAINER.fullmatch(exec_id))
        with self.lock(guard):
            entry = self.read(guard)
            require(entry["state"] == "INVOKING" and entry.get("execId", exec_id) == exec_id)
            entry["execId"] = exec_id
            self.replace(guard, entry)

    def mark_started(self, guard, exec_id):
        with self.lock(guard):
            entry = self.read(guard)
            require(entry.get("execId") == exec_id and entry["state"] in {"INVOKING", "RUNNING", "OBSERVED"})
            if entry["state"] != "OBSERVED":
                entry["state"] = "RUNNING"
                self.replace(guard, entry)

    @contextmanager
    def lock(self, guard):
        descriptor = os.open(self.path(guard).with_suffix(".lock"), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    def replace(self, guard, entry):
        raw = canonical(entry).encode()
        require(len(raw) <= MAX_RESULT + MAX_PLAN)
        temporary = self.path(guard).with_suffix(".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            require(os.write(descriptor, raw) == len(raw))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, self.path(guard))
        self.sync()

    def retire(self, guard, stop_command, ownership):
        with self.lock(guard):
            entry = self.read(guard)
            action = entry["plan"]["action"]
            original = entry.get("createObservation", entry.get("result", {})).get("ownership", {})
            if original.get("containerId") != ownership.get("containerId") or entry["request"]["method"] != "create":
                return None
            proof = {"schema": "lyrashield-native-removal/1", "phase": "EXECUTOR_CREATE",
                     "guardId": guard, "nativeRequestId": guard, "commandId": action["commandId"],
                     "stopCommandId": stop_command, "operationId": action["operationId"], "attemptId": action["attemptId"],
                     "authorityEpochId": action["authorityEpochId"], "bindingInputChecksum": hashlib.sha256(canonical(action).encode()).hexdigest(),
                     "actionChecksum": action["actionChecksum"], "ownership": ownership, "inspection": {"state": "ABSENT"}}
            proof["receiptSha256"] = hashlib.sha256(canonical(proof).encode()).hexdigest()
            if entry.get("removalProof"):
                require(entry["removalProof"] == proof)
            else:
                entry["removalProof"] = proof
                self.replace(guard, entry)
            return proof

    def retire_tools(self, origin, pending, stop_command, ownership):
        require(isinstance(pending, list) and len(pending) <= 32 and ownership["executorKey"] == "sandbox"
                and CONTAINER.fullmatch(ownership.get("containerId", "")))
        original = origin["plan"]["action"]
        seen, proofs = set(), []
        for row in pending:
            guard, binding = row["guardId"], row["bindingInputJson"]
            action, descriptor = json.loads(binding), json.loads(row["actionInputJson"])
            require(ID.fullmatch(guard) and guard not in seen and canonical(action) == binding
                    and canonical(descriptor) == row["actionInputJson"]
                    and hashlib.sha256(row["actionInputJson"].encode()).hexdigest() == row["actionChecksum"]
                    and CONTAINER.fullmatch(row["commandInputChecksum"])
                    and action["phase"] == "SANDBOX_TOOL" and action["executorKey"] == "sandbox"
                    and action["actionChecksum"] == row["actionChecksum"]
                    and descriptor["ownership"] == ownership and descriptor["request"]["requestId"] == action["requestId"]
                    and all(action[key] == original[key] for key in ("operationId", "attemptId", "workspaceId", "authorityEpochId")))
            seen.add(guard)
            proof = {"schema": "lyrashield-native-tool-retirement/1", "phase": "SANDBOX_TOOL",
                     "guardId": guard, "nativeRequestId": guard, "commandId": action["commandId"],
                     "commandInputChecksum": row["commandInputChecksum"], "stopCommandId": stop_command,
                     "operationId": action["operationId"], "attemptId": action["attemptId"],
                     "authorityEpochId": action["authorityEpochId"], "requestId": action["requestId"],
                     "actionChecksum": action["actionChecksum"], "bindingInputJson": binding,
                     "ownership": ownership, "inspection": {"state": "ABSENT"}}
            proof["receiptSha256"] = hashlib.sha256(canonical(proof).encode()).hexdigest()
            # A guard not delivered to this host still receives a durable one-use
            # tombstone. Removal proves quietness; it never claims a start ACK.
            if not self.path(guard).exists():
                plan = {**origin["plan"], "guardId": guard, "action": action, "ownership": ownership, "descriptor": descriptor}
                self.begin(guard, {"schema": 1, "method": "tool", "guardId": guard, "action": action}, plan)
            with self.lock(guard):
                entry = self.read(guard)
                require(entry["request"]["method"] == "tool" and entry["plan"]["action"] == action
                        and entry["plan"]["ownership"] == ownership and entry["plan"]["descriptor"] == descriptor)
                if entry.get("toolRetirementProof"):
                    require(entry["toolRetirementProof"] == proof)
                else:
                    entry.update(state="RETIRED", toolRetirementProof=proof)
                    self.replace(guard, entry)
            proofs.append(proof)
        return proofs

    def record_created(self, guard, inspection):
        with self.lock(guard):
            entry = self.read(guard)
            require(entry["state"] == "INVOKING" and entry["request"]["method"] == "create"
                    and inspection["state"] == "PRESENT" and inspection["running"] is False
                    and CONTAINER.fullmatch(inspection["ownership"].get("containerId", ""))
                    and inspection["ownership"]["ownershipId"] == entry["plan"]["ownership"]["ownershipId"])
            require(entry.get("createObservation", inspection) == inspection)
            entry["createObservation"] = inspection
            self.replace(guard, entry)

    def sync(self):
        descriptor = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def ownership(self, ownership):
        require(isinstance(ownership, dict) and OWN.fullmatch(ownership.get("ownershipId", "")))
        matches = []
        paths = list(self.root.glob("*.json"))
        require(len(paths) <= 10000)
        for path in paths:
            protected(path)
            require(path.stat().st_size <= MAX_RESULT + MAX_PLAN)
            entry = json.loads(path.read_bytes())
            plan = entry.get("plan", {})
            if plan.get("ownership", {}).get("ownershipId") == ownership["ownershipId"]:
                matches.append(entry)
        require(matches)
        creates = [entry for entry in matches if entry["request"]["method"] == "create"]
        require(len(creates) == 1)
        return creates[0]


def installation(peer):
    observer = module("paired-runtime-host-observation")
    if not (Path("/etc/lyrashield") / "runtime-authority.json").exists():
        authority, state = module("disposable-native-authority").load_disposable_native_context(peer, observer)
        protected(Path("/proc") / str(state["pid"]) / "root/app/src/native-host-query.ts")
        return authority, state
    protected(ROOT / "runtime-qualification-key.json")
    pin = json.loads((ROOT / "runtime-qualification-key.json").read_bytes())
    raw = observer.read_private(observer.ROOT / "runtime-authority.json")
    unsigned = json.loads(json.loads(raw)["raw"])
    authority = observer.verify_envelope(raw, pin, {key: unsigned[key] for key in observer.FIELDS}, int(time.time()))
    policy_raw = observer.read_private(observer.ROOT / "runtime-policy.json", 65536)
    require(observer.checksum(policy_raw) == authority["runtimePolicyDigest"])
    policy = json.loads(policy_raw)
    state = observer.component("supervisor", policy, authority)
    state["network"] = policy["network"]
    pid, uid, gid = peer
    require(uid == state["uid"] and gid == state["gid"])
    # Peer must be an actual process of this exact immutable supervisor container.
    expected = (Path("/proc") / str(state["pid"]) / "cgroup").read_bytes()
    require((Path("/proc") / str(pid) / "cgroup").read_bytes() == expected)
    helper = Path("/proc") / str(state["pid"]) / "root/app/src/native-host-query.ts"
    protected(helper)
    return authority, state


def helper_environment():
    observer = module("paired-runtime-host-observation")
    protected(ENV, private=True)
    raw = observer.read_private(ENV, 32768).decode()
    values = {}
    for line in raw.splitlines():
        if not line or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        require(separator and name in ENV_NAMES and name not in values and value and "\0" not in value)
        values[name] = value
    require(set(values) == set(ENV_NAMES))
    return values


def query_plan(request, origin=None):
    env = helper_environment()
    arguments = ["exec", "--interactive", "--user", "0", "--workdir", "/app"]
    for name in ("NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"):
        arguments.extend(["--env", name + "="])
    for name in ENV_NAMES:
        arguments.extend(["--env", name])
    arguments.extend(["lyrashield-supervisor", "node", "--import", "tsx", "/app/src/native-host-query.ts"])
    raw = run_docker(arguments, timeout=3, input=canonical({"request": request, "origin": origin}).encode() + b"\n", env=env, max_output=MAX_PLAN)
    plan = json.loads(raw)
    require(isinstance(plan, dict) and plan.get("schema") == 1 and plan.get("method") == request["method"])
    return plan


@contextmanager
def private_environment(ledger, values):
    require(isinstance(values, dict) and set(values) <= ENGINE_ENV_NAMES | {"LLM_API_KEY"})
    for value in values.values():
        require(isinstance(value, str) and value and not any(item in value for item in ("\0", "\n", "\r"))
                and len(value.encode()) <= 32768)
    raw = "".join(name + "=" + values[name] + "\n" for name in sorted(values)).encode()
    require(len(raw) <= 65536)
    descriptor, path = tempfile.mkstemp(prefix=".native-env-", dir=ledger.root)
    try:
        require(os.fstat(descriptor).st_uid == 0 and stat.S_IMODE(os.fstat(descriptor).st_mode) == 0o600)
        require(os.write(descriptor, raw) == len(raw))
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        yield path
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.unlink(path)


def create_with_private_environment(ledger, args, values):
    require(args[0] == "create")
    if not values:
        return run_docker(args, timeout=3)
    # Docker's explicit --env NAME overrides --env-file even when NAME is
    # missing in the CLI environment. Remove only these trusted dynamic names.
    filtered = []
    index = 0
    while index < len(args):
        if args[index] == "--env" and index + 1 < len(args) and args[index + 1].split("=", 1)[0] in values:
            index += 2
        else:
            filtered.append(args[index])
            index += 1
    with private_environment(ledger, values) as path:
        return run_docker(["create", "--env-file", path, *filtered[1:]], timeout=3)


def prepare_engine_output(ledger, plan):
    parent = ledger.root / "output"
    if not parent.exists():
        parent.mkdir(mode=0o700)
    protected(parent, directory=True, private=True)
    path = parent / hashlib.sha256(plan["ownership"]["ownershipId"].encode()).hexdigest()
    path.mkdir(mode=0o700)
    descriptor = plan["spec"]["resourceDescriptor"]
    os.chown(path, descriptor["uid"], descriptor["gid"])
    require(stat.S_IMODE(path.lstat().st_mode) == 0o700 and path.lstat().st_uid == descriptor["uid"])
    ledger.retain_output_path(plan["guardId"], str(path))
    plan["outputPath"] = str(path)
    return "type=bind,src=" + str(path) + ",dst=/workspace/strix_runs"


def build_engine_manifest(ledger, plan):
    require(plan["ownership"]["executorKey"] == "engine" and isinstance(plan.get("relayRequired"), bool))
    name = "lyrashield-manifest-" + hashlib.sha256(plan["guardId"].encode()).hexdigest()[:32]
    descriptor, path = tempfile.mkstemp(prefix=".manifest-cid-", dir=ledger.root)
    os.close(descriptor)
    os.unlink(path)  # Docker requires a previously absent cidfile in this root-only directory.
    ledger.record_manifest(plan["guardId"], path)
    try:
        raw = run_docker(["run", "--rm", "--pull=never", "--cidfile", path, "--name", name,
            "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", "32", "--memory", "128m", "--cpus", "1", "--user", "65534:65534",
            "--interactive", "--entrypoint", "/bin/busybox", plan["image"], "timeout", "-s", "KILL", "3",
            "/opt/lyrashield-venv/bin/python", "-m", "lyrashield.runtime.controller_manifest"], timeout=3, max_output=16384,
            input=canonical({"scanId": plan["action"]["scanId"], "relayRequired": plan["relayRequired"]}).encode() + b"\n")
        manifest = raw.decode().removesuffix("\n")
        require(len(manifest.encode()) <= 16384 and canonical(json.loads(manifest)) == manifest)
        return manifest
    finally:
        cleanup_manifest(ledger, path, plan)


def cleanup_manifest(ledger, path, plan):
    require(Path(path).parent == ledger.root and Path(path).name.startswith(".manifest-cid-"))
    if Path(path).exists():
        protected(Path(path))
        container_id = Path(path).read_text().strip()
        require(CONTAINER.fullmatch(container_id))
        found = run_docker(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", "id=" + container_id]).decode().split()
        if found:
            rows = json.loads(run_docker(["container", "inspect", container_id]))
            name = "lyrashield-manifest-" + hashlib.sha256(plan["guardId"].encode()).hexdigest()[:32]
            require(found == [container_id] and len(rows) == 1 and rows[0]["Name"] == "/" + name
                    and rows[0]["Config"]["Image"] == plan["image"] and rows[0]["HostConfig"]["NetworkMode"] == "none"
                    and rows[0]["HostConfig"]["ReadonlyRootfs"] is True and rows[0]["HostConfig"]["Privileged"] is False)
            run_docker(["container", "rm", "--force", container_id])
        os.unlink(path)


def inspect_owned(plan, caller=None):
    ownership = plan["ownership"]
    require(OWN.fullmatch(ownership["ownershipId"]))
    ids = run_docker(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", "label=lyrashield.supervisor.ownership=" + ownership["ownershipId"]]).decode().split()
    require(len(ids) <= 1 and all(CONTAINER.fullmatch(item) for item in ids))
    if not ids:
        return {"state": "ABSENT"}
    container_id = ids[0]
    if caller and caller.get("containerId"):
        require(caller["containerId"] == container_id)
    rows = json.loads(run_docker(["container", "inspect", container_id]))
    require(len(rows) == 1)
    row = rows[0]
    images = json.loads(run_docker(["image", "inspect", plan["image"]]))
    require(len(images) == 1 and plan["image"] in images[0]["RepoDigests"] and row["Image"] == images[0]["Id"])
    labels = row["Config"].get("Labels") or {}
    require(row["Id"] == container_id and row["Name"] == "/lyrashield-supervisor-" + ownership["ownershipId"][4:36]
            and labels.get("lyrashield.supervisor.ownership") == ownership["ownershipId"]
            and labels.get("lyrashield.supervisor.attempt") == plan["action"]["attemptId"]
            and row["Config"]["Image"] == plan["image"]
            and row["HostConfig"]["Privileged"] is False
            and row["HostConfig"]["ReadonlyRootfs"] is True
            and row["HostConfig"]["NetworkMode"] == plan["network"]
            and set(row["HostConfig"].get("CapDrop") or []) == {"ALL"}
            and "no-new-privileges" in (row["HostConfig"].get("SecurityOpt") or []))
    spec = plan["spec"]
    descriptor = spec["resourceDescriptor"]
    resources = plan["resources"]
    host, config = row["HostConfig"], row["Config"]
    require(config["User"] == str(descriptor["uid"]) + ":" + str(descriptor["gid"])
            and config["WorkingDir"] == descriptor["workdir"]
            and config["Labels"].get("lyrashield.supervisor.descriptor") == resources["descriptorChecksum"]
            and host["Init"] is True and host["PidMode"] == "" and host["IpcMode"] == "private"
            and not host.get("CapAdd") and not host.get("Devices") and not host.get("DeviceRequests")
            and not host.get("PublishAllPorts") and not host.get("PortBindings")
            and set(row["NetworkSettings"]["Networks"]) == {plan["network"]}
            and host["Memory"] == spec["memoryMb"] * 1048576
            and host["NanoCpus"] == round(spec["cpus"] * 1000000000)
            and host["PidsLimit"] == spec["pidsLimit"] and host["ShmSize"] == descriptor["isolation"]["shmMb"] * 1048576
            and host.get("Tmpfs", {}).get("/tmp") == "rw,noexec,nosuid,nodev,size=256m"
            and host.get("Tmpfs", {}).get(descriptor["workspaceRoot"]) ==
            "rw,nosuid,nodev,uid=" + str(descriptor["uid"]) + ",gid=" + str(descriptor["gid"]) + ",mode=0750"
            and set(host.get("SecurityOpt") or []) == {"no-new-privileges",
                "apparmor=" + descriptor["isolation"]["appArmorProfile"],
                "seccomp=/etc/lyrashield/control/seccomp/" + descriptor["isolation"]["seccompPolicyChecksum"] + ".json"}
            and row["AppArmorProfile"] == descriptor["isolation"]["appArmorProfile"]
            and len(row["Mounts"]) == len(resources["mounts"]) + (1 if ownership["executorKey"] == "engine" else 0)
            and all(mount["Type"] == "bind" and mount["RW"] is False and
                    any(mount["Source"] == expected["source"] and mount["Destination"] == expected["target"] for expected in resources["mounts"])
                    for mount in row["Mounts"] if not (ownership["executorKey"] == "engine" and mount["Destination"] == "/workspace/strix_runs")))
    if ownership["executorKey"] == "engine":
        expected = str(LEDGER / "output" / hashlib.sha256(ownership["ownershipId"].encode()).hexdigest())
        require(plan.get("outputPath") == expected and any(mount["Type"] == "bind" and mount["RW"] is True
                and mount["Source"] == expected and mount["Destination"] == "/workspace/strix_runs" for mount in row["Mounts"]))
        require(len([mount for mount in row["Mounts"] if mount["Destination"] != "/workspace/strix_runs"]) == len(resources["mounts"]))
    actual = dict(ownership, containerId=container_id)
    return {"state": "PRESENT", "running": row["State"]["Running"], "ownership": actual}


def executor_reference(authority, executor_key):
    require(executor_key in {"sandbox", "engine"})
    prefix = "ghcr.io/ecryptoguru/lyrashield-sandbox@" if executor_key == "sandbox" else "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@"
    if authority.get("schema") == "lyrashield-disposable-native-authority/1" and authority.get("purpose") == "disposable-linux-native-tests":
        prefix = "127.0.0.1:5000/lyrashield-fixture/" + ("sandbox" if executor_key == "sandbox" else "worker") + "@"
    return prefix + authority["sandboxDigest" if executor_key == "sandbox" else "workerDigest"]


def verify_executor_image(authority, plan):
    key = plan["ownership"]["executorKey"]
    reference = executor_reference(authority, key)
    require(plan["image"] == reference)
    images = json.loads(run_docker(["image", "inspect", reference]))
    require(len(images) == 1 and reference in images[0]["RepoDigests"])
    architecture = {"x86_64": "amd64", "aarch64": "arm64"}.get(os.uname().machine)
    require(architecture is not None and images[0].get("Architecture") == architecture)
    labels = images[0]["Config"].get("Labels") or {}
    require(labels.get("org.opencontainers.image.revision") == authority["engineRevision" if key == "sandbox" else "productRevision"])
    require(labels.get("org.opencontainers.image.source") == "https://github.com/ecryptoguru/" + ("lyrashield-engine" if key == "sandbox" else "lyrashield-ai"))
    if key == "engine":
        require(labels.get("com.lyrashield.engine.revision") == authority["engineRevision"])


def allowed_native_containers(authority):
    """Census only exact freshly verified containers owned by this root ledger."""
    ledger = NativeLedger()
    allowed = []
    ownership_ids = set()
    paths = list(ledger.root.glob("*.json"))
    require(len(paths) <= 10000)
    for path in paths:
        protected(path)
        require(path.stat().st_size <= MAX_RESULT + MAX_PLAN)
        raw_entry = json.loads(path.read_bytes())
        entry = ledger.read(raw_entry["guardId"])
        require(path == ledger.path(entry["guardId"]))
        if entry["request"]["method"] != "create":
            continue
        require(entry["schema"] == 1 and entry["guardId"] == entry["request"]["guardId"])
        plan = entry["plan"]
        require(plan["action"] == entry["request"]["action"] and plan["guardId"] == entry["guardId"])
        if plan["epochId"] != authority["epochId"] or plan["sourceRevision"] != authority["productRevision"]:
            continue
        require(plan["ownership"]["executorKey"] == plan["action"]["executorKey"])
        require(plan["image"] == executor_reference(authority, plan["ownership"]["executorKey"]))
        verify_executor_image(authority, plan)
        own = plan["ownership"]["ownershipId"]
        require(own not in ownership_ids)
        ownership_ids.add(own)
        observed = inspect_owned(plan)
        if observed["state"] == "PRESENT":
            allowed.append(observed["ownership"]["containerId"])
    require(len(allowed) == len(set(allowed)))
    return allowed


def dispatch(request, peer, ledger):
    require(isinstance(request, dict) and request.get("schema") == 1)
    method = request.get("method")
    require(method in {"create", "start", "inspect", "stop", "tool", "tool-observe", "pty-read", "result-read"})
    effect = method in {"create", "start", "tool", "tool-observe"}
    keys = {"schema", "method", "guardId", "action"} if effect else {"schema", "method", "ownership"}
    if method == "start":
        keys.add("ownership")
    if method == "pty-read":
        keys.update({"sessionId", "outputCursor", "maxOutputBytes"})
    if method == "result-read":
        keys.update({"offset", "maxBytes"})
    require(set(request) == keys)
    authority, state = installation(peer)
    if method in {"inspect", "stop", "pty-read", "result-read"}:
        origin = ledger.ownership(request["ownership"])
        plan = origin["plan"]
        require(plan["sourceRevision"] == authority["productRevision"] and plan["epochId"] == authority["epochId"])
        require(plan["network"] == state["network"])
        if method == "result-read":
            require(plan["ownership"]["executorKey"] == "engine")
            query_plan(request, origin)
            results = module("native-engine-result")
            capture = results.capture_engine_result(ledger, origin, request["ownership"], run_docker)
            ledger.retain_result_capture(origin["guardId"], capture)
            return results.read_engine_result_chunk(ledger, origin, request["ownership"], request["offset"], request["maxBytes"], run_docker)
        if method == "pty-read":
            pty = module("native-executor-pty")
            session = pty.Sessions(ledger).read(request["sessionId"])
            original = ledger.read(session["originalGuardId"])
            require(original["plan"]["ownership"] == request["ownership"]
                    and original["plan"]["epochId"] == plan["epochId"]
                    and original["plan"]["sourceRevision"] == plan["sourceRevision"]
                    and original["plan"]["network"] == plan["network"] and session["state"] in {"RUNNING", "EXITED"}
                    and type(request["maxOutputBytes"]) is int and 1 <= request["maxOutputBytes"] <= 1048576)
            query_plan(request, original)
            return pty.observation(session, original["plan"], request["outputCursor"], request["maxOutputBytes"])["response"]
        stopping = query_plan(request, origin) if method == "stop" else None
        observed = inspect_owned(plan, request["ownership"])
        owned = observed.get("ownership")
        if method == "stop" and observed["state"] == "PRESENT":
            if plan["ownership"]["executorKey"] == "engine" and observed["running"] is False:
                capture = module("native-engine-result").capture_engine_result(ledger, origin, observed["ownership"], run_docker)
                ledger.retain_result_capture(origin["guardId"], capture)
            run_docker(["container", "rm", "--force", observed["ownership"]["containerId"]])
            observed = inspect_owned(plan)
            require(observed["state"] == "ABSENT")
        if method == "stop":
            require(observed["state"] == "ABSENT")
            if not owned:
                owned = origin.get("createObservation", origin.get("result", {})).get("ownership")
            proof = ledger.retire(origin["guardId"], stopping["stopCommandId"], owned) if owned else None
            tools = ledger.retire_tools(origin, stopping["pendingTools"], stopping["stopCommandId"], owned) if owned and owned["executorKey"] == "sandbox" else []
            return {"inspection": observed, **({"nativeRemovalProof": proof} if proof else {}), "nativeToolRetirements": tools}
        return observed
    require(ID.fullmatch(request.get("guardId", "")))
    if method == "tool-observe":
        entry = ledger.read(request["guardId"])
        require(entry["request"]["method"] == "tool" and entry["request"]["action"] == request["action"]
                and entry["plan"]["sourceRevision"] == authority["productRevision"] and entry["plan"]["epochId"] == authority["epochId"])
        query_plan(request, entry)
        kind = entry["plan"]["descriptor"].get("resultKind")
        if kind == "pty/start":
            result = module("native-executor-pty").observe_start(entry["plan"], ledger)
            return ledger.retain_terminal_observation(request["guardId"], result)
        if kind in {"pty/stdin", "pty/terminate"}:
            result = module("native-executor-pty").observe_mutation(entry["plan"], ledger)
            return ledger.retain_terminal_observation(request["guardId"], result)
        return entry["result"] if entry["state"] == "OBSERVED" else {"status": "RUNNING", "execId": entry.get("execId")}
    plan = query_plan(request)
    require(plan["action"] == request["action"] and plan["guardId"] == request["guardId"]
            and plan["epochId"] == authority["epochId"] and plan["sourceRevision"] == authority["productRevision"]
            and plan["ownership"]["executorKey"] == plan["action"]["executorKey"]
            and plan["image"] == executor_reference(authority, plan["ownership"]["executorKey"])
            and plan["network"] == state["network"])
    plan["engineRevision"] = authority["engineRevision"]
    if method == "start" and plan["ownership"]["executorKey"] == "engine":
        original = ledger.ownership(request["ownership"])
        require(original["plan"]["action"]["commandId"] == plan["action"]["commandId"]
                and original["plan"]["action"]["attemptId"] == plan["action"]["attemptId"]
                and original["plan"]["epochId"] == plan["epochId"] and original["plan"]["image"] == plan["image"])
        plan["outputPath"] = original["plan"]["outputPath"]
    # The secret-bearing provider env is never retained in the ledger.
    provider_env = plan.pop("providerEnv", None)
    verify_executor_image(authority, plan)
    ledger.begin(request["guardId"], request, plan)
    if method == "tool":
        if plan["descriptor"].get("resultKind") == "state/renew":
            engine = ledger.engine_for_sandbox(plan)
            require(engine["plan"]["network"] == plan["network"])
            observed_engine = inspect_owned(engine["plan"])
            require(observed_engine["state"] == "PRESENT" and observed_engine["running"] is True)
            observed_sandbox = inspect_owned(plan, plan["ownership"])
            require(observed_sandbox["state"] == "PRESENT" and observed_sandbox["running"] is True)
            signed = query_plan(request, {"manifestInputJson": engine["plan"]["manifestInputJson"]})
            for field in ("schema", "method", "guardId", "action", "epochId", "sourceRevision", "ownership", "image", "network", "createArgs", "spec", "resources", "descriptor"):
                require(signed[field] == plan[field])
            require(signed["expectedSandboxOwnership"] == plan["ownership"])
            observed_sandbox = inspect_owned(plan, plan["ownership"])
            require(observed_sandbox["state"] == "PRESENT" and observed_sandbox["running"] is True)
            plan["stateResult"] = signed["stateResult"]
            ledger.retain_tool_state(request["guardId"], plan["stateResult"])
        kind = plan["descriptor"].get("resultKind")
        tool = module("native-executor-tool")
        if kind == "pty/start":
            result = module("native-executor-pty").execute_pty(plan, run_docker, ledger, tool)
        elif kind in {"pty/stdin", "pty/terminate"}:
            result = module("native-executor-pty").mutation(plan, run_docker, ledger, tool)
        else:
            result = tool.execute_tool(plan, run_docker, ledger)
    elif method == "create":
        require(inspect_owned(plan)["state"] == "ABSENT")
        engine_env = {}
        create_args = plan["createArgs"]
        if plan["ownership"]["executorKey"] == "engine":
            sandbox_origin = ledger.sandbox_for_engine(plan)
            require(sandbox_origin["plan"]["network"] == plan["network"])
            current_sandbox = inspect_owned(sandbox_origin["plan"])
            require(current_sandbox["state"] == "PRESENT" and current_sandbox["running"] is True)
            manifest = build_engine_manifest(ledger, plan)
            signed = query_plan(request, {"manifestInputJson": manifest})
            for field in ("schema", "method", "guardId", "action", "epochId", "sourceRevision", "ownership", "image", "network", "createArgs", "spec", "resources", "relayRequired"):
                require(signed[field] == plan[field])
            engine_env = signed.pop("engineEnv", None)
            require(isinstance(engine_env, dict) and set(engine_env) == ENGINE_ENV_NAMES)
            sandbox_ownership = signed["expectedSandboxOwnership"]
            require(sandbox_ownership == current_sandbox["ownership"])
            sandbox_plan = sandbox_origin["plan"]
            require(sandbox_plan["action"]["operationId"] == plan["action"]["operationId"]
                    and sandbox_plan["action"]["attemptId"] == plan["action"]["attemptId"]
                    and sandbox_plan["epochId"] == plan["epochId"] and sandbox_plan["sourceRevision"] == plan["sourceRevision"]
                    and sandbox_plan["network"] == plan["network"] and sandbox_plan["ownership"]["executorKey"] == "sandbox")
            observed_sandbox = inspect_owned(sandbox_plan, sandbox_ownership)
            require(observed_sandbox["state"] == "PRESENT" and observed_sandbox["running"] is True
                    and observed_sandbox["ownership"] == sandbox_ownership)
            require(engine_env["LYRASHIELD_SUPERVISOR_MANIFEST_INPUT"] == manifest)
            ledger.retain_engine_grant(request["guardId"], signed["sandboxGrant"], signed["sandboxRuntimeAuthority"], sandbox_ownership, manifest)
            output_mount = prepare_engine_output(ledger, plan)
            create_args = ["create", "--mount", output_mount, *create_args[1:]]
        container_id = create_with_private_environment(ledger, create_args, {**(provider_env or {}), **engine_env}).decode().strip()
        require(CONTAINER.fullmatch(container_id))
        result = inspect_owned(plan, {"containerId": container_id})
        require(result["state"] == "PRESENT" and result["running"] is False)
        ledger.record_created(request["guardId"], result)
    else:
        result = inspect_owned(plan, request["ownership"])
        require(result["state"] == "PRESENT" and result["running"] is False)
        container_id = result["ownership"]["containerId"]
        require(run_docker(["container", "start", container_id], timeout=3).decode().strip() == container_id)
        result = inspect_owned(plan, request["ownership"])
        require(result["state"] == "PRESENT" and result["running"] is True)
    query_plan(request)
    if method == "tool":
        return result
    if ledger.read(request["guardId"])["state"] == "INVOKING":
        ledger.complete(request["guardId"], result)
    return result


def handle_connection(conn, ledger):
    with conn:
        try:
            conn.settimeout(3)
            peer = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            raw = bytearray()
            while len(raw) <= MAX_REQUEST and not raw.endswith(b"\n"):
                chunk = conn.recv(min(4096, MAX_REQUEST + 1 - len(raw)))
                if not chunk:
                    return
                raw.extend(chunk)
            require(len(raw) <= MAX_REQUEST and raw.endswith(b"\n") and b"\n" not in raw[:-1])
            result = dispatch(json.loads(raw), peer, ledger)
            response = canonical({"schema": 1, "ok": True, "result": result}).encode() + b"\n"
            require(len(response) <= MAX_RESULT)
            conn.sendall(response)
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError):
            return


def reconcile(ledger):
    """A service restart cannot leave a bounded tool without its root observer."""
    module("native-executor-pty").reconcile_sessions(ledger, inspect_owned, run_docker)
    paths = list(ledger.root.glob("*.json"))
    require(len(paths) <= 10000)
    for path in paths:
        protected(path)
        require(path.stat().st_size <= MAX_RESULT + MAX_PLAN)
        entry = json.loads(path.read_bytes())
        if entry.get("manifestCidPath"):
            cleanup_manifest(ledger, entry["manifestCidPath"], entry["plan"])
        if entry["request"]["method"] != "tool" or entry["state"] in {"OBSERVED", "RETIRED"}:
            continue
        plan = entry["plan"]
        if plan["descriptor"].get("resultKind") == "pty/start":
            pty = module("native-executor-pty")
            require(pty.Sessions(ledger).read(pty.session_id(entry["guardId"])).get("quiet") is True)
        else:
            observed = inspect_owned(plan, plan["ownership"])
            if observed["state"] == "PRESENT":
                run_docker(["container", "rm", "--force", observed["ownership"]["containerId"]])
            require(inspect_owned(plan)["state"] == "ABSENT")
        ledger.complete(entry["guardId"], {
            "execId": entry.get("execId"), "containerId": plan["ownership"].get("containerId"),
            "invocationGuardId": entry["guardId"], "actionChecksum": plan["action"]["actionChecksum"],
            "state": "UNKNOWN", "reasonCode": "NATIVE_OBSERVER_STOPPED", "quiet": True,
        })


def main():
    if sys.argv[1:] == ["--reconcile"]:
        require(os.geteuid() == 0)
        reconcile(NativeLedger())
        return
    require(sys.argv[1:] == [])
    require(os.geteuid() == 0 and os.environ.get("LISTEN_PID") == str(os.getpid()) and os.environ.get("LISTEN_FDS") == "1")
    for path in (Path("/run"), Path("/run/lyrashield"), SOCKET.parent, Path("/opt"), Path("/opt/lyrashield"), ROOT):
        protected(path, directory=True)
    info = SOCKET.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and info.st_gid == grp.getgrnam("lyrashield-supervisor").gr_gid and stat.S_IMODE(info.st_mode) == 0o660)
    ledger = NativeLedger()
    lock = os.open(LEDGER / "service.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    reconcile(ledger)
    with socket.socket(fileno=3) as server:
        require(server.family == socket.AF_UNIX and server.getsockname() == str(SOCKET) and server.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 1)
        server.settimeout(1)
        while True:
            # Reap bounded observers only between requests, while no Docker CLI
            # subprocess is being awaited. SIGCHLD=SIG_IGN loses CLI exit codes.
            try:
                while os.waitpid(-1, os.WNOHANG)[0]:
                    pass
            except ChildProcessError:
                pass
            try:
                connection, _ = server.accept()
            except socket.timeout:
                continue
            handle_connection(connection, ledger)


if __name__ == "__main__":
    main()
