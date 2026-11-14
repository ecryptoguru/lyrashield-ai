#!/usr/bin/python3
"""Purpose-specific root preparation signer and exact persisted-revision source installer."""
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import tempfile
import threading
import time

ROOT = Path("/opt/lyrashield/runtime-control")
SOCKET = Path("/run/lyrashield/control/preparation.sock")
CONTROL = Path("/etc/lyrashield/control")
STATE = Path("/var/lib/lyrashield/preparation")
INPUTS = Path("/var/lib/lyrashield/control/inputs")
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$")
SHA = re.compile(r"^[a-f0-9]{64}$")
GIT_SHA = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
MAX = 128 * 1024


def require(value):
    if not value:
        raise RuntimeError("Protected preparation unavailable")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def checksum(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value).encode()).hexdigest()


def protected(path, directory=False):
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    info = path.lstat()
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and info.st_uid == 0 and not info.st_mode & 0o022)
    require(directory or info.st_nlink == 1)


def module(name):
    path = ROOT / (name + ".py")
    protected(path)
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def write_once(path, value, mode=0o600):
    raw = value if isinstance(value, bytes) else canonical(value).encode()
    require(len(raw) <= MAX)
    if path.exists():
        protected(path)
        require(path.read_bytes() == raw)
        return
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        require(os.write(descriptor, raw) == len(raw))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def replace_state(path, value):
    # Only the unsigned acquisition state changes. Issued attempt records/catalogs are immutable.
    protected(path)
    with tempfile.NamedTemporaryFile(dir=STATE, delete=False) as stream:
        temporary = Path(stream.name)
        raw = canonical(value).encode()
        require(len(raw) <= MAX)
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def operation_lock(operation):
    protected(STATE, True)
    require(stat.S_IMODE(STATE.lstat().st_mode) == 0o700)
    descriptor = os.open(STATE / (checksum(operation.encode()) + ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        require(info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600)
        require(fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB) is None)
        yield
    finally:
        os.close(descriptor)


def execute(args, *, data=None, env=None, timeout=45, maximum=40 * 1024 * 1024, pass_fds=()):
    # Direct argv only. Source credentials live in child env/private pipes, never argv or Git config.
    with tempfile.TemporaryFile() as output:
        limits = ["--fsize=" + str(maximum)]
        if args[0] == "/usr/bin/git":
            limits.append("--as=536870912")
        child = subprocess.Popen(["/usr/bin/prlimit", *limits, "--", *args],
                                 stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                                 stdout=output, stderr=subprocess.DEVNULL, start_new_session=True,
                                 env=env or {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"}, pass_fds=pass_fds)
        try:
            child.communicate(data, timeout=timeout)
            require(child.returncode == 0)
        except BaseException:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise
        output.seek(0)
        raw = output.read(maximum + 1)
        require(len(raw) <= maximum)
        return raw


def installation(peer, measure=True):
    observer = module("paired-runtime-host-observation")
    pin_path = ROOT / "runtime-qualification-key.json"
    protected(pin_path)
    pin = json.loads(pin_path.read_bytes())
    envelope_raw = observer.read_private(observer.ROOT / "runtime-authority.json")
    unsigned = json.loads(json.loads(envelope_raw)["raw"])
    authority = observer.verify_envelope(envelope_raw, pin, {key: unsigned[key] for key in observer.FIELDS}, int(time.time()))
    policy_raw = observer.read_private(observer.ROOT / "runtime-policy.json", 65536)
    require(observer.checksum(policy_raw) == authority["runtimePolicyDigest"])
    policy = json.loads(policy_raw)
    delegation = observer.verify_preparation_delegation(policy, authority, pin)
    require(delegation is not None)
    if measure:
        installed = observer.load_execution_authority(pin)
    else:
        # Fast staged-purpose read; it never replaces PREPARE's actual post-INSERT installed capability.
        control = observer.load_seal_gate_configuration(authority["productRevision"], pin)
        installed = {"purpose": "production-installed", "epochId": authority["epochId"], "epoch": authority["epoch"],
                     "sourceRevision": authority["productRevision"], "runtimePolicyDigest": authority["runtimePolicyDigest"],
                     "authorityDigest": observer.checksum(envelope_raw), "supervisorInstanceId": control["supervisorInstanceId"], "preparation": delegation}
    state = observer.component("broker", policy, authority)
    pid, uid, gid = peer
    require(uid == state["uid"] and gid == state["gid"])
    require((Path("/proc") / str(pid) / "cgroup").read_bytes() == (Path("/proc") / str(state["pid"]) / "cgroup").read_bytes())
    # This one path crosses the kernel's /proc/PID/root symlink for the already
    # inspected read-only container. It is never accepted as a caller path.
    script = Path("/proc") / str(state["pid"]) / "root/app/src/preparation-source.ts"
    script_info = script.lstat()
    require(stat.S_ISREG(script_info.st_mode) and script_info.st_uid == 0 and script_info.st_nlink == 1 and not script_info.st_mode & 0o022)
    preparation = json.loads(observer.read_private(observer.ROOT / "preparation-host-policy.json", 65536))
    return observer, pin, installed, authority, preparation


def current_delegation(installed):
    delegation = installed["preparation"]
    now = time.time()
    require(datetime.fromisoformat(delegation["issuedAt"].replace("Z", "+00:00")).timestamp() <= now)
    require(now < datetime.fromisoformat(delegation["expiresAt"].replace("Z", "+00:00")).timestamp())
    return delegation


def read_source(operation, credential, include_bytes):
    request = {"operationId": operation, "credentialHash": credential}
    args = ["/usr/bin/docker", "exec", "--interactive", "--workdir", "/app"]
    for name in ("NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"):
        args += ["--env", name + "="]
    args += ["lyrashield-broker", "node", "--import", "tsx", "/app/src/preparation-source.ts"]
    before = json.loads(execute(args, data=canonical(request).encode(), maximum=MAX))
    if not include_bytes:
        return before
    acquired = acquire_artifacts(before)
    require(read_source(operation, credential, False) == before)
    return {**before, **acquired}


def acquire_artifacts(source):
    # The host root process uses the qualified read-only image ABI/dependency closure.
    # Enter only its mount/root namespace: network remains the protected host's network.
    # This creates no Docker container and never adds public egress to a controller role.
    observer = module("paired-runtime-host-observation")
    pin = json.loads((ROOT / "runtime-qualification-key.json").read_bytes())
    installed = observer.load_execution_authority(pin)
    current_delegation(installed)
    envelope = json.loads(observer.read_private(observer.ROOT / "runtime-authority.json"))
    authority = json.loads(envelope["raw"])
    policy = json.loads(observer.read_private(observer.ROOT / "runtime-policy.json", 65536))
    broker = observer.component("broker", policy, authority)
    process = Path("/proc") / str(broker["pid"])
    environment = dict(entry.decode().split("=", 1) for entry in (process / "environ").read_bytes().split(b"\0") if entry)
    # Shared SDK configuration is scoped to reads. Database uses the independently restricted source role.
    sdk = {key: environment[key] for key in ("BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "PLATFORM_ADMIN_EMAILS", "TRUSTED_PROXY_IP_HEADER", "IP_HASH_SALT")}
    sdk.update({"NODE_ENV": "production", "DATABASE_URL": environment["LYRASHIELD_PREPARATION_SOURCE_DATABASE_URL"],
                "LYRASHIELD_REQUIRE_EMAIL_VERIFICATION": "0", **observer.read_preparation_github_env()})
    if source["attachments"]:
        sdk.update(observer.read_preparation_evidence_env(policy))
    for name in ("preparation-acquire.mjs", "preparation-acquisition.ts"):
        item = process / "root/app/src" / name
        info = item.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o222)
    node = process / "root/usr/local/bin/node"
    node_info = node.lstat()
    require(stat.S_ISREG(node_info.st_mode) and node_info.st_uid == 0 and not node_info.st_mode & 0o022)
    root_fd = os.open(process / "root", os.O_PATH | os.O_DIRECTORY)
    # Snapshot root-managed host resolver bytes; Docker's internal DNS cannot serve host-network SDK reads.
    resolver_path = Path("/etc/resolv.conf").resolve(strict=True)
    protected(resolver_path)
    resolver_raw = resolver_path.read_bytes()
    require(0 < len(resolver_raw) <= 8192)
    namespace_fd = os.open(process / "ns/mnt", os.O_RDONLY)
    launcher = ROOT / "preparation-acquisition-host.py"
    protected(launcher)
    try:
        with tempfile.TemporaryDirectory(prefix="acquisition-", dir=STATE) as mount_root:
            # A unique root-only real inode can be cloned as a mount; never a caller-selected resolver.
            resolver_path = Path(mount_root) / "resolver.snapshot"
            resolver_path.write_bytes(resolver_raw)
            resolver_path.chmod(0o400)
            resolver_fd = os.open(resolver_path, os.O_RDONLY | os.O_NOFOLLOW)
            image_mount = Path(mount_root) / "image"
            image_mount.mkdir(mode=0o700)
            try:
                args = ["/usr/bin/python3", "-I", str(launcher), str(root_fd), str(namespace_fd), str(resolver_fd), str(image_mount)]
                result = json.loads(execute(args, data=canonical({"environment": sdk, "source": source}).encode(),
                                            maximum=8 * 1024 * 1024, timeout=45, pass_fds=(root_fd, namespace_fd, resolver_fd)))
            finally:
                os.close(resolver_fd)
    finally:
        os.close(namespace_fd)
        os.close(root_fd)
    require(set(result) == {"token", "attachmentBytes"} and isinstance(result["token"], str) and 0 < len(result["token"]) <= 8192)
    require(observer.component("broker", policy, authority) == broker and observer.load_execution_authority(pin) == installed)
    return result


def freeze(root):
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            path = Path(directory) / name
            info = path.lstat()
            require(stat.S_ISDIR(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink == 1))
            require(info.st_uid == 0)
            os.chown(path, 0, 1000, follow_symlinks=False)
            path.chmod(0o550 if stat.S_ISDIR(info.st_mode) or info.st_mode & 0o111 else 0o440)
    os.chown(root, 0, 1000)
    root.chmod(0o550)


def install_repository(root, source):
    deadline = time.monotonic() + 90
    plan = source["executionPlan"]
    require(plan["targetType"] == "REPO" and plan["workflow"] in ("REVIEW_TARGET", "REVIEW_CHANGES"))
    revision = plan["source"]["revision"]
    revisions = list(dict.fromkeys(plan["source"].values()))
    require(all(GIT_SHA.fullmatch(item) and len(item) == len(revision) for item in revisions))
    full_name, token = source["target"]["repoFullName"], source["token"]
    require(re.fullmatch(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}", full_name))
    require(all(part not in (".", "..") for part in full_name.split("/")))
    require(re.fullmatch(r"[A-Za-z0-9._-]{1,8192}", token))
    url = "https://github.com/" + full_name + ".git"
    env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "8"}
    pairs = [("http." + url + ".extraheader", "Authorization: Basic " + base64.b64encode(("x-access-token:" + token).encode()).decode()),
             ("http.followRedirects", "false"), ("credential.helper", ""), ("core.hooksPath", "/dev/null"),
             ("protocol.file.allow", "never"), ("protocol.ext.allow", "never"), ("core.autocrlf", "false"), ("core.fileMode", "false")]
    for index, (key, value) in enumerate(pairs):
        env["GIT_CONFIG_KEY_" + str(index)] = key
        env["GIT_CONFIG_VALUE_" + str(index)] = value
    def git(*args, maximum=3 * 1024 * 1024):
        remaining = deadline - time.monotonic()
        require(remaining > 0)
        return execute(["/usr/bin/git", "-C", str(root), *args], env=env, timeout=remaining, maximum=maximum)
    git("init", "--quiet", "--object-format=" + ("sha256" if len(revision) == 64 else "sha1"))
    # The engine computes merge-base for Review Changes. Keep actual ancestry;
    # depth-one comparison tips would erase it even when both objects exist.
    fetch_options = [] if plan["workflow"] == "REVIEW_CHANGES" else ["--depth=1"]
    git("fetch", "--quiet", "--no-tags", *fetch_options, url, *revisions)
    if plan["workflow"] == "REVIEW_CHANGES":
        require(git("merge-base", plan["source"]["mergeBaseRevision"], revision).decode().strip() == plan["source"]["mergeBaseRevision"])
    # Enumerate exact committed blobs before any checkout/filter execution. Symlinks/submodules are closed.
    entries = git("ls-tree", "-r", "-z", revision).split(b"\0")
    require(len(entries) <= 10001)
    total = 0
    for entry in entries:
        if not entry:
            continue
        metadata, path_bytes = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        require(mode in ("100644", "100755") and kind == "blob" and GIT_SHA.fullmatch(oid))
        name = path_bytes.decode("utf-8", "strict")
        require(name and not name.startswith("/") and all(part not in ("", ".", "..", ".git") for part in name.split("/")))
        size = int(git("cat-file", "-s", oid))
        total += size
        require(size <= 5 * 1024 * 1024 and total <= 20 * 1024 * 1024)
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = git("cat-file", "blob", oid, maximum=5 * 1024 * 1024)
        require(len(raw) == size)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o750 if mode == "100755" else 0o640)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw)
        except Exception:
            raise
    git("update-ref", "HEAD", revision)
    git("read-tree", revision)
    require(git("rev-parse", "HEAD").decode().strip() == revision)
    freeze(root)
    return module("source-tree").read_source_tree(root)


def stage(request, peer):
    operation, credential = request["operationId"], request["credentialHash"]
    observer, pin, installed, authority, policy = installation(peer)
    current_delegation(installed)
    with operation_lock(operation):
        record_path = STATE / (checksum(operation.encode()) + ".json")
        existing = json.loads(observer.read_private(record_path, MAX)) if record_path.exists() else None
        source = read_source(operation, credential, existing is None or existing["state"] == "BUILDING")
        # Only immutable persisted identities are retained; credentials and plaintext are never journaled.
        snapshot = {key: value for key, value in source.items() if key not in ("token", "attachmentBytes")}
        require(snapshot["authorityEpochId"] == installed["epochId"] and snapshot["operationId"] == operation)
        if existing:
            require(existing["snapshot"] == snapshot and existing["installed"] == installed)
        if existing and existing["state"] == "READY":
            require(module("source-tree").read_source_tree(INPUTS / existing["resources"]["source"]["grantId"])["stagedTreeDigest"] == existing["resources"]["source"]["stagedTreeDigest"])
            return {"staged": True}
        protected(INPUTS, True)
        suffix = checksum(operation.encode())[:40]
        source_id, egress_id = "source:" + suffix, "egress:" + suffix
        if existing:
            require(existing["state"] == "BUILDING")
            # A durable BUILDING record cannot be signed or installed. These exact
            # unissued input roots can therefore be rebuilt after failed acquisition.
            for grant_id in (source_id, egress_id, "attachments:" + suffix):
                unpublished = INPUTS / grant_id
                if unpublished.exists():
                    protected(unpublished, True)
                    shutil.rmtree(unpublished)
        else:
            write_once(record_path, {"state": "BUILDING", "snapshot": snapshot, "installed": installed})
        source_root = INPUTS / source_id
        source_root.mkdir(mode=0o700)
        tree = install_repository(source_root, source)
        egress_path = CONTROL / "egress" / (policy["isolation"]["networkPolicyChecksum"] + ".json")
        egress_raw = observer.read_private(egress_path, 65536)
        egress = json.loads(egress_raw)
        require(checksum(egress_raw) == policy["isolation"]["networkPolicyChecksum"] and canonical(egress).encode() == egress_raw)
        require(egress.get("authorizedHosts") == [] and egress.get("relayRequired") is False)
        egress_root = INPUTS / egress_id
        egress_root.mkdir(mode=0o700)
        write_once(egress_root / "policy.json", egress_raw, 0o440)
        freeze(egress_root)
        attachments = None
        if snapshot["attachments"]:
            attachment_id = "attachments:" + suffix
            attachment_root = INPUTS / attachment_id
            attachment_root.mkdir(mode=0o700)
            entries = []
            payloads = {item["id"]: item["content"] for item in source["attachmentBytes"]}
            for item in snapshot["attachments"]:
                name = item["stagingName"]
                require("/" not in name and "\\" not in name and name not in (".", ".."))
                raw = base64.b64decode(payloads[item["id"]], validate=True)
                require(len(raw) == item["byteLength"] and checksum(raw) == item["checksum"])
                # Attachment policy has separate bounded limits; source-tree size does not truncate it.
                descriptor = os.open(attachment_root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o440)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(raw)
                entries.append({"id": item["id"], "checksum": item["checksum"], "byteLength": item["byteLength"],
                                "contentType": item["mediaType"], "filename": item["filename"], "containerPath": "/input/attachments/" + name})
            freeze(attachment_root)
            attachments = {"grantId": attachment_id, "root": "/input/attachments", "manifestChecksum": checksum(entries), "entries": entries, "readOnly": True}
        inventory = {
            "engine": observer.inspect_image(policy["engineImage"], policy["productRevision"], "https://github.com/ecryptoguru/lyrashield-ai"),
            "sandbox": observer.inspect_image(policy["sandboxImage"], policy["engineRevision"], "https://github.com/ecryptoguru/lyrashield-engine"),
        }
        require(inventory["engine"]["Config"].get("Entrypoint") in (None, []))
        require(inventory["sandbox"]["Config"].get("Entrypoint") == ["docker-entrypoint.sh"])
        require(observer.load_execution_authority(pin) == installed)
        resources = {"source": {"grantId": source_id, "root": "/workspace/source", "revision": snapshot["executionPlan"]["source"]["revision"], "stagedTreeDigest": tree["stagedTreeDigest"], "readOnly": True},
                     "attachments": attachments, "relay": None,
                     "egress": {"grantId": egress_id, "policyPath": "/run/lyrashield-egress/policy.json", "policyChecksum": checksum(egress_raw), "authorizedHosts": [], "relayRequired": False, "readOnly": True}}
        record = {"state": "READY", "snapshot": snapshot, "installed": installed, "resources": resources,
                  "observed": {"inventoryReceiptChecksum": checksum(inventory), "runtimeReceiptChecksum": checksum(installed),
                               "inputReceiptChecksum": checksum({"tree": tree, "egress": checksum(egress_raw), "attachments": attachments}),
                               "engineEntrypoint": [], "sandboxEntrypoint": ["docker-entrypoint.sh"]}}
        require(read_source(operation, credential, False) == snapshot)
        replace_state(record_path, record)
        return {"staged": True}


def bind(request, peer):
    # The attempt is uncommitted on PREPARE's original gated connection. Bind only to the
    # previously authenticated persisted operation; actual command/action verification follows INSERT.
    operation, supplied = request["operationId"], request["authority"]
    observer, _, installed, _, policy = installation(peer, False)
    delegation = current_delegation(installed)
    with operation_lock(operation):
        saved = json.loads(observer.read_private(STATE / (checksum(operation.encode()) + ".json"), MAX))
        require(saved["state"] == "READY")
        snapshot = saved["snapshot"]
        require(saved["installed"] == installed)
        for key in ("executionPlanHash", "targetSnapshotDigest", "scopeDigest", "policyDigest", "executionPlan", "workerGrantId"):
            require(supplied[key] == snapshot[key])
        attempt = supplied["attempt"]
        require(attempt["operationId"] == operation and attempt["scanId"] == snapshot["scanId"] and attempt["workspaceId"] == snapshot["workspaceId"])
        require(attempt["authorityEpochId"] == installed["epochId"] and attempt["workerIdentity"] == snapshot["workerInstanceId"])
        require(ID.fullmatch(attempt["attemptId"]))
        expiry = min(datetime.fromisoformat(attempt["expiresAt"].replace("Z", "+00:00")).timestamp(), time.time() + 900,
                     datetime.fromisoformat(delegation["expiresAt"].replace("Z", "+00:00")).timestamp())
        require(expiry > time.time())
        require(module("source-tree").read_source_tree(INPUTS / saved["resources"]["source"]["grantId"])["stagedTreeDigest"] == saved["resources"]["source"]["stagedTreeDigest"])
        record = {"schema": "lyrashield-preparation-staging/2", "purpose": "production-preparation", "executionContext": {"environment": "PRODUCTION", "installed": installed},
                  "issuerKeyHash": policy["issuerKeyHash"], "issuedAt": datetime.now(timezone.utc).isoformat(), "expiresAt": datetime.fromtimestamp(expiry, timezone.utc).isoformat(),
                  "operationId": operation, "attemptId": attempt["attemptId"], "scanId": snapshot["scanId"], "workspaceId": snapshot["workspaceId"], "authorityEpochId": installed["epochId"],
                  "executionPlanHash": snapshot["executionPlanHash"], "targetSnapshotDigest": snapshot["targetSnapshotDigest"], "scopeDigest": snapshot["scopeDigest"], "policyDigest": snapshot["policyDigest"],
                  "hostPolicyChecksum": delegation["preparationPolicyChecksum"], "images": {"engine": policy["engineImage"], "sandbox": policy["sandboxImage"]},
                  "resources": saved["resources"], "observed": saved["observed"]}
        path = STATE / ("attempt-" + checksum(attempt["attemptId"].encode()) + ".json")
        if path.exists():
            envelope = json.loads(observer.read_private(path, MAX))
            previous = json.loads(envelope["raw"])
            require({key: value for key, value in previous.items() if key not in ("issuedAt", "expiresAt")} == {key: value for key, value in record.items() if key not in ("issuedAt", "expiresAt")})
            require(datetime.fromisoformat(previous["expiresAt"]).timestamp() > time.time())
            return envelope
        raw = canonical(record)
        signature = observer.output(["openssl", "dgst", "-sha256", "-sign", str(CONTROL / "preparation-grant-key.pem")], input_bytes=raw.encode(), limit=1024)
        envelope = {"raw": raw, "result": {"algorithm": "RS256", "keyId": delegation["issuerKeyId"], "signature": base64.b64encode(signature).decode()}}
        write_once(path, envelope)
        return envelope


def install(request, peer):
    observer, _, installed, _, policy = installation(peer, False)
    current_delegation(installed)
    descriptors = request["descriptors"]
    require(isinstance(descriptors, list) and len(descriptors) == 2)
    envelope = json.loads(observer.read_private(STATE / ("attempt-" + checksum(request["attemptId"].encode()) + ".json"), MAX))
    record = json.loads(envelope["raw"])
    record_checksum = checksum(envelope["raw"].encode())
    require(record["operationId"] == request["operationId"] and record["attemptId"] == request["attemptId"] and record["executionContext"]["installed"] == installed)
    require(datetime.fromisoformat(record["expiresAt"]).timestamp() > time.time())
    images = {policy["engineImage"].split("@")[1], policy["sandboxImage"].split("@")[1]}
    require({item["imageDigest"] for item in descriptors} == images)
    for item in descriptors:
        require(set(item) == {"schema", "hostPolicyChecksum", "imageDigest", "uid", "gid", "workspaceRoot", "workdir", "source", "attachments", "relay", "egress", "scratchRoot", "isolation", "stagingRecordChecksum", "issuerKeyHash"})
        require(item["schema"] == "lyrashield-executor-resources/1" and item["stagingRecordChecksum"] == record_checksum)
        require(item["issuerKeyHash"] == policy["issuerKeyHash"] and item["hostPolicyChecksum"] == record["hostPolicyChecksum"])
        require(item["uid"] == 1000 and item["gid"] == 1000 and item["workspaceRoot"] == "/workspace" and item["workdir"] == "/workspace" and item["scratchRoot"] == "/workspace/.attachments-scratch")
        require(item["isolation"] == {**policy["isolation"], "dropCapabilities": "ALL", "noNewPrivileges": True, "readOnlyRoot": True, "shmMb": 512})
        require(all(item[key] == record["resources"][key] for key in ("source", "attachments", "relay", "egress")))
    inputs = [{"kind": "source", "grantId": record["resources"]["source"]["grantId"], "checksum": record["resources"]["source"]["stagedTreeDigest"]},
              {"kind": "egress", "grantId": record["resources"]["egress"]["grantId"], "checksum": record["resources"]["egress"]["policyChecksum"]}]
    if record["resources"]["attachments"]:
        item = record["resources"]["attachments"]
        inputs.append({"kind": "attachments", "grantId": item["grantId"], "checksum": item["manifestChecksum"]})
    catalog = {"schema": "lyrashield-protected-resource-installation/1", "attemptId": request["attemptId"], "stagingRecordChecksum": record_checksum,
               "hostPolicyChecksum": record["hostPolicyChecksum"], "issuerKeyHash": policy["issuerKeyHash"], "descriptorChecksums": sorted(checksum(item) for item in descriptors),
               "expiresAt": record["expiresAt"], "network": policy["network"], "networkPolicyChecksum": policy["isolation"]["networkPolicyChecksum"], "inputs": inputs}
    protected(CONTROL / "resources", True)
    write_once(CONTROL / "resources" / (record_checksum + ".json"), catalog)
    return {"installed": True}


def dispatch(request, peer):
    require(isinstance(request, dict) and request.get("schema") == 1 and ID.fullmatch(request.get("operationId", "")))
    method = request.get("method")
    keys = {"schema", "method", "operationId"}
    if method == "stage":
        require(set(request) == keys | {"credentialHash"} and SHA.fullmatch(request["credentialHash"]))
        return stage(request, peer)
    if method == "bind":
        require(set(request) == keys | {"authority"})
        return bind(request, peer)
    if method == "install":
        require(set(request) == keys | {"attemptId", "descriptors"} and ID.fullmatch(request["attemptId"]))
        return install(request, peer)
    require(False)


def handle(connection):
    with connection:
        try:
            connection.settimeout(180)
            peer = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            raw = bytearray()
            while len(raw) <= MAX and not raw.endswith(b"\n"):
                chunk = connection.recv(min(8192, MAX + 1 - len(raw)))
                require(chunk)
                raw.extend(chunk)
            require(len(raw) <= MAX and raw.count(b"\n") == 1)
            response = canonical(dispatch(json.loads(raw), peer)).encode()
            require(len(response) <= MAX)
            connection.sendall(response + b"\n")
        except Exception:
            return


def main():
    require(os.geteuid() == 0 and os.environ.get("LISTEN_PID") == str(os.getpid()) and os.environ.get("LISTEN_FDS") == "1")
    group = grp.getgrnam("lyrashield-broker")
    require(group.gr_gid > 0 and not group.gr_mem)
    protected(SOCKET.parent, True)
    info = SOCKET.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and info.st_gid == group.gr_gid and stat.S_IMODE(info.st_mode) == 0o660)
    listener = socket.fromfd(3, socket.AF_UNIX, socket.SOCK_STREAM)
    require(listener.getsockname() == str(SOCKET))
    capacity = threading.BoundedSemaphore(8)
    def worker(connection):
        try:
            handle(connection)
        finally:
            capacity.release()
    while True:
        connection, _ = listener.accept()
        if not capacity.acquire(blocking=False):
            connection.close()
            continue
        threading.Thread(target=worker, args=(connection,), daemon=True).start()


if __name__ == "__main__":
    main()
