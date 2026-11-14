"""Bounded root capture of one owned engine run and its immutable staged source."""

import base64
import hashlib
import importlib.util
import json
import os
import re
import stat
import tempfile
from pathlib import Path

ROOT = Path("/opt/lyrashield/runtime-control")
INPUTS = Path("/var/lib/lyrashield/control/inputs")
MAX_BUNDLE = 96 * 1024 * 1024
MAX_CHUNK = 1024 * 1024
MAX_ENTRIES = 10000
ARTIFACTS = {
    "run.json": 1024 * 1024,
    "vulnerabilities.json": 10 * 1024 * 1024,
    "coverage.json": 256 * 1024,
    "http_exchanges.json": 2 * 1024 * 1024,
    "threat_model.json": 32 * 1024 * 1024,
}
ATTRS = (
    "st_dev",
    "st_ino",
    "st_mode",
    "st_uid",
    "st_gid",
    "st_nlink",
    "st_size",
    "st_mtime_ns",
    "st_ctime_ns",
)
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$")
HASH = re.compile(r"^[a-f0-9]{64}$")
REVISION = re.compile(r"^[a-f0-9]{40}$")
OWN = re.compile(r"^own_[a-f0-9]{40}$")


def require(value):
    if not value:
        raise RuntimeError("Owned engine output unavailable")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def unchanged(before, after):
    require(all(getattr(before, name) == getattr(after, name) for name in ATTRS))


def private_directory(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    info = path.lstat()
    require(
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == 0
        and info.st_gid == 0
        and stat.S_IMODE(info.st_mode) == 0o700
    )


def scope(origin, ownership):
    plan = origin["plan"]
    action = plan["action"]
    require(
        origin["schema"] == 1
        and origin["request"]["method"] == "create"
        and origin["state"] == "OBSERVED"
        and origin["guardId"] == origin["request"]["guardId"]
        and action == origin["request"]["action"]
    )
    require(
        plan["ownership"]["executorKey"] == "engine"
        and plan["ownership"]["kind"] == "container"
        and OWN.fullmatch(plan["ownership"]["ownershipId"])
    )
    observed = origin.get("createObservation", origin.get("result", {})).get(
        "ownership"
    )
    require(
        ownership == observed
        and ownership["ownershipId"] == plan["ownership"]["ownershipId"]
        and re.fullmatch(r"[a-f0-9]{64}", ownership["containerId"])
    )
    for field in (
        "operationId",
        "attemptId",
        "scanId",
        "workspaceId",
        "authorityEpochId",
    ):
        require(
            isinstance(action[field], str)
            and ID.fullmatch(action[field])
            and ".." not in action[field]
        )
    require(
        ID.fullmatch(origin["guardId"])
        and REVISION.fullmatch(plan["sourceRevision"])
        and action["authorityEpochId"] == plan["epochId"]
        and "@sha256:" in plan["image"]
    )
    return plan, action


def capture_path(ledger, ownership, create=True):
    private_directory(ledger.root)
    root = ledger.root / "results"
    private_directory(root, create=create)
    return root / (
        hashlib.sha256(ownership["ownershipId"].encode()).hexdigest() + ".json"
    )


def output_path(ledger, plan):
    root = ledger.root / "output"
    private_directory(root)
    expected = (
        root / hashlib.sha256(plan["ownership"]["ownershipId"].encode()).hexdigest()
    )
    require(plan["outputPath"] == str(expected))
    return expected


def held_file(directory, name, uid, limit):
    """Open relative to a held directory; no links, FIFOs or changing bytes."""
    before = os.stat(name, dir_fd=directory, follow_symlinks=False)
    require(
        stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1
    )
    if before.st_size > limit:
        return None
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        unchanged(before, os.fstat(fd))
        raw = bytearray()
        remaining = before.st_size
        while remaining:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            require(chunk)
            raw.extend(chunk)
            remaining -= len(chunk)
        require(os.read(fd, 1) == b"")
        unchanged(before, os.fstat(fd))
        unchanged(before, os.stat(name, dir_fd=directory, follow_symlinks=False))
        return bytes(raw)
    finally:
        os.close(fd)


def source_module():
    path = ROOT / "source-tree.py"
    info = path.lstat()
    require(
        stat.S_ISREG(info.st_mode)
        and info.st_uid == 0
        and info.st_nlink == 1
        and not info.st_mode & 0o022
    )
    spec = importlib.util.spec_from_file_location("engine_export_source_tree", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def export_source(plan, budget):
    descriptor = plan["spec"]["resourceDescriptor"].get("source")
    unknown = None
    if not descriptor:
        return unknown
    try:
        require(
            REVISION.fullmatch(descriptor["revision"])
            and HASH.fullmatch(descriptor["stagedTreeDigest"])
            and ID.fullmatch(descriptor["grantId"])
            and ".." not in descriptor["grantId"]
            and descriptor["readOnly"] is True
        )
        path = INPUTS / descriptor["grantId"]
        require(
            any(
                item["source"] == str(path) and item["target"] == descriptor["root"]
                for item in plan["resources"]["mounts"]
            )
        )
        reader = source_module()
        initial = reader.read_source_tree(path)
        require(initial["stagedTreeDigest"] == descriptor["stagedTreeDigest"])
        directories, files = [], []
        used = 0

        def walk(fd, relative, depth):
            nonlocal used
            require(depth <= 64)
            before = os.fstat(fd)
            require(
                stat.S_ISDIR(before.st_mode)
                and before.st_uid == 0
                and not before.st_mode & 0o222
            )
            for name in sorted(os.listdir(fd)):
                require(
                    name not in (".", "..") and "/" not in name and "\0" not in name
                )
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                relative_path = relative + "/" + name if relative else name
                require(
                    len(directories) + len(files) < MAX_ENTRIES
                    and info.st_uid == 0
                    and not info.st_mode & 0o222
                )
                if stat.S_ISDIR(info.st_mode):
                    directories.append(relative_path)
                    child = os.open(
                        name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
                    )
                    try:
                        unchanged(info, os.fstat(child))
                        walk(child, relative_path, depth + 1)
                    finally:
                        os.close(child)
                else:
                    raw = held_file(fd, name, 0, 5 * 1024 * 1024)
                    require(raw is not None)
                    record = {
                        "path": relative_path,
                        "bytes": len(raw),
                        "checksum": hashlib.sha256(raw).hexdigest(),
                        "base64": base64.b64encode(raw).decode(),
                    }
                    used += len(canonical(record).encode()) + 1
                    require(used <= budget)
                    files.append(record)
            unchanged(before, os.fstat(fd))

        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            walk(fd, "", 0)
        finally:
            os.close(fd)
        require(reader.read_source_tree(path) == initial)
        require(
            sorted(
                [
                    {name: record[name] for name in ("path", "bytes", "checksum")}
                    for record in files
                ],
                key=lambda entry: entry["path"],
            )
            == sorted(initial["entries"], key=lambda entry: entry["path"])
        )
        result = {
            "revision": descriptor["revision"],
            "stagedTreeDigest": descriptor["stagedTreeDigest"],
            "directories": directories,
            "files": files,
        }
        require(len(canonical(result).encode()) <= budget)
        return result
    except (RuntimeError, OSError, KeyError, TypeError, ValueError):
        return unknown


def export_artifacts(ledger, plan, budget):
    records = {}
    try:
        root = output_path(ledger, plan)
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            uid, gid = (
                plan["spec"]["resourceDescriptor"]["uid"],
                plan["spec"]["resourceDescriptor"]["gid"],
            )
            require(
                info.st_uid == uid
                and info.st_gid == gid
                and stat.S_IMODE(info.st_mode) == 0o700
            )
            run = os.open(
                plan["action"]["scanId"],
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=fd,
            )
        finally:
            os.close(fd)
    except (RuntimeError, OSError, KeyError):
        return {name: "UNREADABLE" for name in ARTIFACTS}
    try:
        directory = os.fstat(run)
        require(directory.st_uid == uid and directory.st_gid == gid)
        for name, maximum in ARTIFACTS.items():
            try:
                raw = held_file(run, name, uid, maximum)
                if raw is None:
                    record = "CAPPED"
                else:
                    record = {
                        "bytes": len(raw),
                        "checksum": hashlib.sha256(raw).hexdigest(),
                        "base64": base64.b64encode(raw).decode(),
                    }
                    size = len(canonical(record).encode()) + 1
                    if size > budget:
                        record = "CAPPED"
                    else:
                        budget -= size
            except FileNotFoundError:
                record = "ABSENT"
            except (RuntimeError, OSError):
                record = "UNREADABLE"
            records[name] = record
        unchanged(directory, os.fstat(run))
    except (RuntimeError, OSError):
        records = {name: "UNREADABLE" for name in ARTIFACTS}
    finally:
        os.close(run)
    return records


def snapshot(ledger, origin, ownership, run_docker):
    plan, action = scope(origin, ownership)
    rows = json.loads(run_docker(["container", "inspect", ownership["containerId"]]))
    require(len(rows) == 1)
    row = rows[0]
    labels = row["Config"].get("Labels") or {}
    state = row["State"]
    require(
        row["Id"] == ownership["containerId"]
        and row["Config"]["Image"] == plan["image"]
        and labels.get("lyrashield.supervisor.ownership") == ownership["ownershipId"]
        and labels.get("lyrashield.supervisor.attempt") == action["attemptId"]
        and state["Running"] is False
        and state.get("Status") == "exited"
        and type(state["ExitCode"]) is int
        and 0 <= state["ExitCode"] <= 255
        and all(
            isinstance(state[name], str) and not state[name].startswith("0001-")
            for name in ("StartedAt", "FinishedAt")
        )
    )
    images = json.loads(run_docker(["image", "inspect", plan["image"]]))
    require(
        len(images) == 1
        and plan["image"] in images[0]["RepoDigests"]
        and row["Image"] == images[0]["Id"]
    )
    image_labels = images[0]["Config"].get("Labels") or {}
    engine = image_labels.get("com.lyrashield.engine.revision")
    require(
        image_labels.get("org.opencontainers.image.revision") == plan["sourceRevision"]
        and isinstance(engine, str)
        and REVISION.fullmatch(engine)
    )
    if "engineRevision" in plan:
        require(engine == plan["engineRevision"])
    bundle = {
        "schema": "lyrashield-native-engine-output/1",
        "guardId": origin["guardId"],
        "ownership": ownership,
        "action": action,
        "productRevision": plan["sourceRevision"],
        "engineRevision": engine,
        "engineImageDigest": plan["image"].split("@")[1],
        "startedAt": state["StartedAt"],
        "finishedAt": state["FinishedAt"],
        "exitCode": state["ExitCode"],
    }
    # Source comes first: it is needed by independent deterministic scanners.
    bundle["source"] = export_source(plan, MAX_BUNDLE - 1024 * 1024)
    remaining = MAX_BUNDLE - len(canonical(bundle).encode()) - 65536
    bundle["artifacts"] = export_artifacts(ledger, plan, remaining)
    require(
        json.loads(run_docker(["container", "inspect", ownership["containerId"]]))[0]
        == row
    )
    raw = canonical(bundle).encode()
    require(len(raw) <= MAX_BUNDLE)
    return raw


def read_capture(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(
            stat.S_ISREG(before.st_mode)
            and before.st_uid == 0
            and before.st_gid == 0
            and before.st_nlink == 1
            and stat.S_IMODE(before.st_mode) == 0o600
            and before.st_size <= MAX_BUNDLE
        )
        raw = bytearray()
        while len(raw) < before.st_size:
            part = os.read(fd, min(1024 * 1024, before.st_size - len(raw)))
            require(part)
            raw.extend(part)
        require(os.read(fd, 1) == b"")
        unchanged(before, os.fstat(fd))
        unchanged(before, path.lstat())
        return bytes(raw)
    finally:
        os.close(fd)


def capture_engine_result(ledger, origin, ownership, run_docker):
    scope(origin, ownership)
    path = capture_path(ledger, ownership)
    if path.exists() or path.is_symlink():
        raw = read_capture(path)
    else:
        raw = snapshot(ledger, origin, ownership, run_docker)
        fd, temporary = tempfile.mkstemp(prefix=".capture-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            # Never replace another completed capture, including a racing caller.
            os.link(temporary, path, follow_symlinks=False)
            os.unlink(temporary)
            descriptor = os.open(
                path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            )
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    bundle = json.loads(raw)
    plan, action = scope(origin, ownership)
    require(
        bundle["ownership"] == ownership
        and bundle["guardId"] == origin["guardId"]
        and bundle["action"] == action
        and bundle["productRevision"] == plan["sourceRevision"]
        and bundle["engineImageDigest"] == plan["image"].split("@")[1]
    )
    proof = {"sha256": hashlib.sha256(raw).hexdigest(), "totalBytes": len(raw)}
    require(not origin.get("resultCapture") or origin["resultCapture"] == proof)
    return proof


def read_engine_result_chunk(ledger, origin, ownership, offset, max_bytes, run_docker):
    require(
        type(offset) is int
        and offset >= 0
        and type(max_bytes) is int
        and 1 <= max_bytes <= MAX_CHUNK
    )
    proof = capture_engine_result(ledger, origin, ownership, run_docker)
    raw = read_capture(capture_path(ledger, ownership))
    require(
        len(raw) == proof["totalBytes"]
        and hashlib.sha256(raw).hexdigest() == proof["sha256"]
        and offset <= len(raw)
    )
    return {
        "schema": 1,
        "offset": offset,
        **proof,
        "chunkBase64": base64.b64encode(raw[offset : offset + max_bytes]).decode(),
    }


def read_operation_proof(ledger, assigned, authority):
    """Only cached root bytes for the exact current worker-assigned operation."""
    matches = []
    paths = list(ledger.root.glob("*.json"))
    require(len(paths) <= 10000)
    for path in paths:
        # NativeLedger.read performs the private held-file check and ID binding.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            require(
                stat.S_ISREG(before.st_mode)
                and before.st_uid == 0
                and before.st_nlink == 1
                and stat.S_IMODE(before.st_mode) == 0o600
                and before.st_size <= 3 * 1024 * 1024
            )
            raw = os.read(fd, 3 * 1024 * 1024 + 1)
            unchanged(before, os.fstat(fd))
            require(len(raw) == before.st_size)
            guard = json.loads(raw)["guardId"]
        finally:
            os.close(fd)
        origin = ledger.read(guard)
        require(path == ledger.path(guard))
        plan = origin["plan"]
        action = plan["action"]
        if (
            origin["request"]["method"] != "create"
            or plan["ownership"]["executorKey"] != "engine"
            or any(
                action[key] != assigned[key]
                for key in ("operationId", "attemptId", "scanId", "workspaceId")
            )
        ):
            continue
        require(
            plan["epochId"] == authority["epochId"]
            and plan["sourceRevision"] == authority["productRevision"]
            and plan["image"].split("@")[1] == authority["workerDigest"]
        )
        ownership = origin.get("createObservation", origin.get("result", {}))[
            "ownership"
        ]
        scope(origin, ownership)
        capture = read_capture(capture_path(ledger, ownership, create=False))
        bundle = json.loads(capture)
        require(
            bundle["schema"] == "lyrashield-native-engine-output/1"
            and bundle["action"] == action
            and bundle["guardId"] == guard
            and bundle["ownership"] == ownership
            and bundle["productRevision"] == authority["productRevision"]
            and bundle["engineRevision"] == authority["engineRevision"]
            and bundle["engineImageDigest"] == authority["workerDigest"]
        )
        matches.append(
            {
                "action": action,
                "guardId": guard,
                "ownership": ownership,
                "sha256": hashlib.sha256(capture).hexdigest(),
                "totalBytes": len(capture),
            }
        )
        require(
            not origin.get("resultCapture")
            or origin["resultCapture"]
            == {key: matches[-1][key] for key in ("sha256", "totalBytes")}
        )
    require(len(matches) == 1)
    return matches[0]
