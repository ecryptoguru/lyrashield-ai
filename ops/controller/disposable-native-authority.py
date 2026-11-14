#!/usr/bin/python3
"""Separate finite authority for an isolated Linux native test daemon.

This capability cannot be consumed by production observation or promotion.
"""
import base64
import json
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import urlsplit

ROOT = Path("/etc/lyrashield")
PURPOSE = "disposable-linux-native-tests"
CONTEXT = "lyrashield-disposable-native-context/1"
SCHEMA = "lyrashield-disposable-native-authority/1"
HEX = re.compile(r"^[a-f0-9]{64}$")
SOURCE = re.compile(r"^[a-f0-9]{40}$")
BOOT = re.compile(r"^[a-f0-9-]{36}$")
OWNER = re.compile(r"^[1-9][0-9]*:[1-9][0-9]*$")
DEPENDENCIES = {"database", "redis", "provider"}


def require(value):
    if not value:
        raise RuntimeError("Disposable native authority unavailable")


def validate_record(record, context, fields, now, boot_id):
    metadata = {"schema", "purpose", "epochId", "epoch", "owner", "bootId", "nonce", "sourceTree", "issuedAt", "expiresAt", "dependencies"}
    require(set(record) == set(fields) | metadata)
    require(set(context) == {"schema", "owner", "bootId", "nonce", "sourceRevision", "sourceTree"})
    require(record["schema"] == SCHEMA and record["purpose"] == PURPOSE and context["schema"] == CONTEXT)
    require(OWNER.fullmatch(record["owner"]) and record["owner"] == context["owner"])
    require(BOOT.fullmatch(record["bootId"]) and record["bootId"] == context["bootId"] == boot_id)
    require(HEX.fullmatch(record["nonce"]) and record["nonce"] == context["nonce"])
    require(SOURCE.fullmatch(record["productRevision"]) and record["productRevision"] == context["sourceRevision"])
    require(SOURCE.fullmatch(record["sourceTree"]) and record["sourceTree"] == context["sourceTree"])
    require(type(record["issuedAt"]) is int and type(record["expiresAt"]) is int
            and 0 < record["issuedAt"] <= now < record["expiresAt"] <= record["issuedAt"] + 3600)
    require(re.fullmatch(r"disposable-[a-f0-9]{32}", record["epochId"]))
    require(type(record["epoch"]) is int and 0 < record["epoch"] <= 2147483647)
    require(set(record["dependencies"]) == DEPENDENCIES)
    for role, dependency in record["dependencies"].items():
        require(set(dependency) == {"name", "image"})
        require(re.fullmatch(r"lyrashield-fixture-" + role + r"-[a-f0-9]{16}", dependency["name"]))
        require(re.fullmatch(r"[a-z0-9./_-]+@sha256:[a-f0-9]{64}", dependency["image"]))
    return record


def load_disposable_native_context(peer, observer):
    envelope_raw = observer.read_private(ROOT / "disposable-native-authority.json", 16384)
    pin_raw = observer.read_private(ROOT / "disposable-native-pin.json", 8192)
    context = json.loads(observer.read_private(ROOT / "disposable-native-context.json", 4096))
    envelope, pin = json.loads(envelope_raw), json.loads(pin_raw)
    require(set(envelope) == {"raw", "result"})
    require(set(pin) == {"purpose", "algorithm", "keyId", "publicKey"} and pin["purpose"] == PURPOSE)
    require(pin["keyId"].startswith("disposable-") and pin["algorithm"] == "RS256")
    record = json.loads(envelope["raw"])
    require(envelope["raw"] == observer.canonical(record))
    validate_record(record, context, observer.FIELDS, int(time.time()), Path("/proc/sys/kernel/random/boot_id").read_text().strip())
    signature = envelope["result"]
    require(set(signature) == {"algorithm", "keyId", "signature"} and signature["algorithm"] == "RS256"
            and signature["keyId"] == pin["keyId"])
    raw_signature = base64.b64decode(signature["signature"], validate=True)
    require(len(raw_signature) == 384 and base64.b64encode(raw_signature).decode() == signature["signature"])
    with tempfile.TemporaryDirectory(prefix="lyrashield-disposable-native-") as directory:
        path = Path(directory)
        (path / "key.pem").write_text(observer.public_pem(pin))
        (path / "signature").write_bytes(raw_signature)
        observer.output(["openssl", "dgst", "-sha256", "-verify", str(path / "key.pem"), "-signature", str(path / "signature")], input_bytes=envelope["raw"].encode(), limit=256)
    policy_raw = observer.read_private(ROOT / "runtime-policy.json", 65536)
    require(observer.checksum(policy_raw) == record["runtimePolicyDigest"])
    policy = json.loads(policy_raw)
    require(policy["schema"] in {"lyrashield-runtime-host-policy/1", "lyrashield-runtime-host-policy/2"}
            and set(policy["components"]) == set(observer.ROLES))
    networks = json.loads(observer.output(["docker", "network", "inspect", policy["network"]]))
    require(len(networks) == 1 and networks[0]["Internal"] is True)
    roles = {role: observer.component(role, policy, record, fixture_reference=
             "127.0.0.1:5000/lyrashield-fixture/" + role + "@" + record["providerGatewayDigest" if role == "provider-gateway" else role + "Digest"])
             for role in observer.ROLES}
    supervisor = roles["supervisor"]
    supervisor["network"] = policy["network"]
    pid, uid, gid = peer
    require(uid == supervisor["uid"] and gid == supervisor["gid"])
    require((Path("/proc") / str(pid) / "cgroup").read_bytes() == (Path("/proc") / str(supervisor["pid"]) / "cgroup").read_bytes())
    dependency_ids = set()
    for dependency in record["dependencies"].values():
        rows = json.loads(observer.output(["docker", "container", "inspect", dependency["name"]]))
        require(len(rows) == 1)
        row = rows[0]
        host = row["HostConfig"]
        require(row["Config"]["Image"] == dependency["image"] and row["State"]["Running"] is True
                and host["NetworkMode"] == policy["network"] and host["Privileged"] is False
                and host["PidMode"] == "" and not host.get("PortBindings") and not host.get("PublishAllPorts")
                and not host.get("Devices") and not host.get("DeviceRequests")
                and len(row["NetworkSettings"]["Networks"]) == 1)
        image = json.loads(observer.output(["docker", "image", "inspect", dependency["image"]]))
        require(len(image) == 1 and dependency["image"] in image[0]["RepoDigests"] and row["Image"] == image[0]["Id"])
        dependency_ids.add(row["Id"])
    # There is no connection to a production database, Redis or model provider.
    native_env = observer.read_private(ROOT / "native-executor.env", 32768).decode()
    values = dict(line.split("=", 1) for line in native_env.splitlines() if line and not line.startswith("#"))
    database = urlsplit(values["LYRASHIELD_SCAN_EXECUTION_DATABASE_URL"])
    provider = urlsplit(values["LYRASHIELD_PROVIDER_GATEWAY_URL"])
    require(database.scheme in {"postgres", "postgresql"} and database.hostname == record["dependencies"]["database"]["name"])
    require(provider.hostname == record["dependencies"]["provider"]["name"] and provider.scheme == "http")
    require(values["LYRASHIELD_PRODUCT_REVISION"] == record["productRevision"] and values["LYRASHIELD_AUTHORITY_EPOCH_ID"] == record["epochId"])
    require(values["LYRASHIELD_SUPERVISOR_INSTANCE_ID"] == policy["journalSealControl"]["supervisorInstanceId"])
    supervisor["supervisorInstanceId"] = values["LYRASHIELD_SUPERVISOR_INSTANCE_ID"]
    # The outer fixture daemon must be isolated by the launcher; role mounts and
    # networks are re-read above. Production paths never call this parser.
    require(observer.read_private(ROOT / "disposable-native-authority.json", 16384) == envelope_raw)
    return record, supervisor
