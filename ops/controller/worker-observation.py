#!/usr/bin/python3
"""Read actual installed worker identity and its separately scoped private grant."""

import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path("/opt/lyrashield/runtime-control")
CONFIG = Path("/etc/lyrashield/control/worker-authority.json")
ENV = Path("/etc/lyrashield/worker-observer.env")
QUERY = "/app/apps/worker/src/worker-host-query.ts"


def require(value):
    if not value:
        raise RuntimeError("Installed worker authority unavailable")


def public_config(observer, group):
    for parent in reversed(CONFIG.parents):
        info = parent.lstat()
        require(
            stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
        )
    descriptor = os.open(CONFIG, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        require(
            stat.S_ISREG(before.st_mode)
            and before.st_uid == 0
            and before.st_gid == group
            and before.st_nlink == 1
            and stat.S_IMODE(before.st_mode) == 0o440
            and before.st_size <= 16384
        )
        raw = os.read(descriptor, 16385)
        after = os.fstat(descriptor)
        require(
            len(raw) == before.st_size
            and (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            == (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        )
        return raw
    finally:
        os.close(descriptor)


def observe(peer, observer, request=None):
    if request is not None:
        require(
            isinstance(request, dict)
            and type(request.get("schema")) is int
            and request["schema"] == 1
            and request.get("method")
            in {"inventory", "result-proof", "cleanup-authority", "cleanup-inventory"}
        )
        expected = (
            {"schema", "method", "operationId"}
            if request["method"] == "result-proof"
            else {"schema", "method"}
            | (
                {"cursor"}
                if request["method"] in {"inventory", "cleanup-inventory"}
                and "cursor" in request
                else set()
            )
        )
        require(set(request) == expected)
        require(
            all(
                isinstance(request[key], str)
                and observer.IDENTIFIER.fullmatch(request[key])
                and ".." not in request[key]
                for key in expected - {"schema", "method"}
            )
        )
    cleanup = request is not None and request["method"] in {
        "cleanup-authority",
        "cleanup-inventory",
    }
    operations_requested = (
        request is not None and request["method"] != "cleanup-authority"
    )
    pin_path = ROOT / "runtime-qualification-key.json"
    metadata = pin_path.lstat()
    require(
        stat.S_ISREG(metadata.st_mode)
        and metadata.st_uid == 0
        and metadata.st_nlink == 1
        and not metadata.st_mode & 0o022
        and metadata.st_size <= 16384
    )
    pin_raw = pin_path.read_bytes()
    pin = json.loads(pin_raw)
    raw = observer.read_private(observer.ROOT / "runtime-authority.json")
    unsigned = json.loads(json.loads(raw)["raw"])
    authority = observer.verify_envelope(
        raw,
        pin,
        {field: unsigned[field] for field in observer.FIELDS},
        int(time.time()),
    )
    # Cleanup retains the original signed tuple and measured installed worker.
    # The separate SQL reader proves its immutable assignment and accepted
    # attempt even after its original grant expires or epoch closes. It grants
    # no current execution, output, provider or readiness authority.
    authority_digest = observer.checksum(raw)
    if not cleanup:
        installed = observer.load_execution_authority(pin)
        require(authority_digest == installed["authorityDigest"])
    policy_raw = observer.read_private(observer.ROOT / "runtime-policy.json", 65536)
    require(observer.checksum(policy_raw) == authority["runtimePolicyDigest"])
    policy = json.loads(policy_raw)
    require(
        policy["schema"]
        in {"lyrashield-runtime-host-policy/1", "lyrashield-runtime-host-policy/2"}
        and set(policy["components"]) == set(observer.ROLES)
    )
    worker = observer.component("worker", policy, authority, retained_cleanup=cleanup)
    pid, uid, gid = peer
    require(uid == worker["uid"] and gid == worker["gid"])
    require(
        (Path("/proc") / str(pid) / "cgroup").read_bytes()
        == (Path("/proc") / str(worker["pid"]) / "cgroup").read_bytes()
    )
    values = policy["components"]["worker"]["environment"]
    instance, grant = (
        values["LYRASHIELD_WORKER_INSTANCE_ID"],
        values["LYRASHIELD_WORKER_INSTANCE_GRANT_ID"],
    )
    require(
        all(
            isinstance(value, str)
            and observer.IDENTIFIER.fullmatch(value)
            and ".." not in value
            for value in (instance, grant)
        )
    )
    configuration = public_config(observer, gid)
    require(
        observer.checksum(configuration)
        == values["LYRASHIELD_WORKER_INSTALLATION_CHECKSUM"]
    )
    mounted = (
        Path("/proc")
        / str(worker["pid"])
        / "root/opt/lyrashield-runtime/worker-authority.json"
    )
    require(mounted.read_bytes() == configuration)
    files = policy["components"]["worker"]["credentialFiles"]
    credential = (
        observer.read_private(
            Path(files["LYRASHIELD_WORKER_INSTANCE_CREDENTIAL"]), 4096
        )
        .decode()
        .strip()
    )
    credential_hash = hashlib.sha256(credential.encode()).hexdigest()
    parsed_config = json.loads(configuration)
    require(
        set(parsed_config) == {"schema", "authority", "workerCredential"}
        and parsed_config["schema"] == "lyrashield-worker-broker-installation/1"
        and parsed_config["workerCredential"] == credential
    )
    expected_config = {
        "productRevision": authority["productRevision"],
        "workerImageDigest": authority["workerDigest"],
        "engineRevision": authority["engineRevision"],
        "authorityEpochId": authority["epochId"],
        "epoch": authority["epoch"],
        "workerInstanceId": instance,
        "workerGrantId": grant,
    }
    require(
        set(parsed_config["authority"]) == set(expected_config) | {"expiresAt"}
        and all(
            parsed_config["authority"][name] == value
            for name, value in expected_config.items()
        )
    )
    line = observer.read_private(ENV, 8192).decode().strip()
    name, separator, connection = line.partition("=")
    require(
        name == "WORKER_OBSERVER_DATABASE_URL"
        and separator
        and "\n" not in connection
        and "\0" not in connection
    )
    info = ENV.lstat()
    require(info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o400)
    reader = urlsplit(connection)
    broker_file = policy["components"]["broker"]["credentialFiles"][
        "LYRASHIELD_SCAN_EXECUTION_DATABASE_URL"
    ]
    broker = urlsplit(observer.read_private(Path(broker_file), 4096).decode().strip())
    require(
        reader.scheme in ("postgres", "postgresql")
        and unquote(reader.username or "") == "app_native_origin_reader"
        and (reader.hostname, reader.port or 5432, reader.path)
        == (broker.hostname, broker.port or 5432, broker.path)
    )
    helper = Path("/proc") / str(worker["pid"]) / ("root" + QUERY)
    for path in [*reversed(helper.parents), helper]:
        # /proc itself supplies the kernel-held root link; inspect the fixed code
        # and its in-image ancestors instead of accepting request-selected paths.
        if path == helper or str(path).startswith(
            str(Path("/proc") / str(worker["pid"]) / "root/app")
        ):
            metadata = path.stat()
            require(metadata.st_uid == 0 and not metadata.st_mode & 0o222)
    query = {
        "authorityEpochId": authority["epochId"],
        "epoch": authority["epoch"],
        "workerInstanceId": instance,
        "workerGrantId": grant,
        "credentialHash": credential_hash,
    }
    if cleanup:
        query["cleanup"] = True
    if operations_requested:
        query["operations"] = True
        query.update(
            {key: request[key] for key in ("operationId", "cursor") if key in request}
        )
    result = subprocess.run(
        [
            "/usr/bin/docker",
            "exec",
            "--interactive",
            "--user",
            "0",
            "--workdir",
            "/app/apps/worker",
            "--env",
            "WORKER_OBSERVER_DATABASE_URL",
            "lyrashield-worker",
            "node",
            "--import",
            "tsx",
            QUERY,
        ],
        input=observer.canonical(query).encode() + b"\n",
        capture_output=True,
        timeout=5,
        check=False,
        env={"PATH": "/usr/bin:/bin", "WORKER_OBSERVER_DATABASE_URL": connection},
    )
    require(
        result.returncode == 0
        and 0 < len(result.stdout) <= (32768 if request else 4096)
    )
    observed = json.loads(result.stdout)
    require(
        set(observed)
        == {"schema", "current", "expiresAt"}
        | ({"cleanup"} if cleanup else set())
        | ({"operations"} if operations_requested else set())
        and observed["schema"] == "lyrashield-root-worker-grant-observation/1"
        and observed["current"] is (not cleanup)
        and (not cleanup or observed["cleanup"] is True)
        and isinstance(observed["expiresAt"], str)
    )
    configured_expiry = parsed_config["authority"]["expiresAt"]
    require(isinstance(configured_expiry, str))
    configured_date = datetime.fromisoformat(configured_expiry.replace("Z", "+00:00"))
    observed_date = datetime.fromisoformat(observed["expiresAt"].replace("Z", "+00:00"))
    require(
        configured_date.tzinfo is not None
        and observed_date.tzinfo is not None
        and (
            cleanup or min(configured_date, observed_date) > datetime.now(timezone.utc)  # noqa: UP017 -- installed Ubuntu Python 3.10 compatibility
        )
    )
    expiry = (
        configured_expiry if configured_date <= observed_date else observed["expiresAt"]
    )
    require(
        observer.component("worker", policy, authority, retained_cleanup=cleanup)
        == worker
        and public_config(observer, gid) == configuration
        and observer.read_private(observer.ROOT / "runtime-authority.json") == raw
        and observer.read_private(observer.ROOT / "runtime-policy.json", 65536)
        == policy_raw
        and pin_path.read_bytes() == pin_raw
    )
    descriptor = {
        "purpose": "production-worker-installed-cleanup"
        if cleanup
        else "production-worker-installed",
        "qualificationDigest": authority["acceptanceDigest"][7:],
        "authorityDigest": authority_digest,
        "productRevision": authority["productRevision"],
        "workerImageDigest": authority["workerDigest"],
        "engineRevision": authority["engineRevision"],
        "runtimePolicyDigest": authority["runtimePolicyDigest"],
        "authorityEpochId": authority["epochId"],
        "epoch": authority["epoch"],
        "workerInstanceId": instance,
        "workerGrantId": grant,
        "expiresAt": expiry,
    }
    if not operations_requested:
        return descriptor
    operations = observed["operations"]
    require(isinstance(operations, list) and len(operations) <= 32)
    for operation in operations:
        require(
            isinstance(operation, dict)
            and set(operation)
            == {"operationId", "workspaceId", "scanId", "attemptId", "state"}
        )
        require(
            all(
                isinstance(operation[key], str)
                and observer.IDENTIFIER.fullmatch(operation[key])
                and ".." not in operation[key]
                for key in ("operationId", "workspaceId", "scanId", "attemptId")
            )
        )
        require(
            isinstance(operation["state"], str) and 0 < len(operation["state"]) <= 32
        )
    if request["method"] in {"inventory", "cleanup-inventory"}:
        return {
            "schema": "lyrashield-root-worker-operation-inventory/1",
            "authority": descriptor,
            "operations": operations,
        }
    require(
        len(operations) == 1 and operations[0]["operationId"] == request["operationId"]
    )
    modules = {}
    for name in ("native-engine-result", "native-executor"):
        path = ROOT / (name + ".py")
        metadata = path.lstat()
        require(
            stat.S_ISREG(metadata.st_mode)
            and metadata.st_uid == 0
            and metadata.st_nlink == 1
            and not metadata.st_mode & 0o022
        )
        spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
        modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(modules[name])
    proof = modules["native-engine-result"].read_operation_proof(
        modules["native-executor"].NativeLedger(), operations[0], authority
    )
    require(
        observer.component("worker", policy, authority) == worker
        and public_config(observer, gid) == configuration
    )
    return {
        "schema": "lyrashield-root-worker-result-proof/1",
        "authority": descriptor,
        **proof,
    }


def main():
    require(
        os.geteuid() == 0
        and len(sys.argv) == 4
        and all(value.isdecimal() for value in sys.argv[1:])
    )
    peer = tuple(map(int, sys.argv[1:]))
    require(all(0 < value <= 2147483647 for value in peer))
    path = ROOT / "paired-runtime-host-observation.py"
    for parent in (Path("/opt"), Path("/opt/lyrashield"), ROOT):
        metadata = parent.lstat()
        require(
            stat.S_ISDIR(metadata.st_mode)
            and metadata.st_uid == 0
            and not metadata.st_mode & 0o022
        )
    metadata = path.lstat()
    require(
        stat.S_ISREG(metadata.st_mode)
        and metadata.st_uid == 0
        and metadata.st_nlink == 1
        and not metadata.st_mode & 0o022
    )
    spec = importlib.util.spec_from_file_location("worker_root_observer", path)
    observer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(observer)
    request_bytes = sys.stdin.buffer.read(4097)
    require(len(request_bytes) <= 4096)
    request = json.loads(request_bytes) if request_bytes else None
    print(observer.canonical(observe(peer, observer, request)))


if __name__ == "__main__":
    main()
