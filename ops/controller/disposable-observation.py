#!/usr/bin/python3
"""Bounded root-only observation of a separately signed disposable capability."""

import importlib.util
import json
import os
import stat
import sys
from pathlib import Path

ROOT = Path("/opt/lyrashield/runtime-control")


def load(name):
    for parent in (Path("/opt"), Path("/opt/lyrashield"), ROOT):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("Protected disposable observer unavailable")
    path = ROOT / (name + ".py")
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
    ):
        raise RuntimeError("Protected disposable observer unavailable")
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def descriptor(peer, observer, disposable):
    record, supervisor = disposable.load_disposable_native_context(peer, observer)
    envelope = observer.read_private(
        observer.ROOT / "disposable-native-authority.json", 16384
    )
    # Pin the emitted digest to the same authenticated record, never a reread substitution.
    observer.require(json.loads(json.loads(envelope)["raw"]) == record)
    policy_raw = observer.read_private(observer.ROOT / "runtime-policy.json", 65536)
    observer.require(observer.checksum(policy_raw) == record["runtimePolicyDigest"])
    policy = json.loads(policy_raw)
    instance = supervisor["supervisorInstanceId"]
    observer.require(
        isinstance(instance, str)
        and observer.IDENTIFIER.fullmatch(instance)
        and ".." not in instance
    )
    observer.require(
        policy["components"]["supervisor"]["environment"][
            "LYRASHIELD_SUPERVISOR_INSTANCE_ID"
        ]
        == instance
    )
    observer.require(type(record["epoch"]) is int and 0 < record["epoch"] <= 2147483647)
    return {
        "purpose": "disposable-installed",
        "epochId": record["epochId"],
        "epoch": record["epoch"],
        "sourceRevision": record["productRevision"],
        "runtimePolicyDigest": record["runtimePolicyDigest"],
        "authorityDigest": observer.checksum(envelope),
        "supervisorInstanceId": instance,
        **{
            name: record[name]
            for name in (
                "owner",
                "bootId",
                "nonce",
                "sourceTree",
                "issuedAt",
                "expiresAt",
            )
        },
    }


def main():
    if (
        os.geteuid() != 0
        or len(sys.argv) != 4
        or not all(value.isdecimal() for value in sys.argv[1:])
    ):
        raise RuntimeError("Root peer observation required")
    peer = tuple(map(int, sys.argv[1:]))
    if not all(0 < value <= 2147483647 for value in peer):
        raise RuntimeError("Non-root disposable supervisor peer required")
    observer = load("paired-runtime-host-observation")
    disposable = load("disposable-native-authority")
    print(observer.canonical(descriptor(peer, observer, disposable)))


if __name__ == "__main__":
    main()
