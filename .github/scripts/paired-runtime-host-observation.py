#!/usr/bin/python3
"""Read-only root observation of an installed, signed controller authority."""

import base64
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from datetime import datetime

ROOT = Path("/etc/lyrashield")
ROLES = ("broker", "supervisor", "provider-gateway", "worker")
CONTROL_KEYS = {
    "broker": ("LYRASHIELD_BROKER_CONTROL_TOKEN",),
    "supervisor": (
        "LYRASHIELD_SUPERVISOR_CONTROL_TOKEN",
        "LYRASHIELD_SUPERVISOR_SIGNING_SECRET",
        "LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN",
    ),
    "provider-gateway": (
        "LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN",
        "LYRASHIELD_PROVIDER_GATEWAY_SIGNING_SECRET",
        "LYRASHIELD_PROVIDER_GATEWAY_RESPONSE_ENCRYPTION_SECRET",
    ),
    "worker": ("LYRASHIELD_WORKER_INSTANCE_CREDENTIAL",),
}
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
REVISION = re.compile(r"^[a-f0-9]{40}$")
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$")
FIELDS = (
    "productRevision",
    "engineRevision",
    "workerDigest",
    "sandboxDigest",
    "brokerDigest",
    "supervisorDigest",
    "providerGatewayDigest",
    "migrationChecksum",
    "runtimePolicyDigest",
)

EPOCH_PROBE = r"""
const {createRequire}=require('node:module');
const {Client}=createRequire('/app/packages/db/package.json')('pg');
const client=new Client({connectionString:process.env.LYRASHIELD_SCAN_EXECUTION_DATABASE_URL,
  connectionTimeoutMillis:5000,statement_timeout:5000});
(async()=>{
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const role=await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    if(role.rows.length!==1||role.rows[0].rolsuper||role.rows[0].rolbypassrls)throw Error();
    const result=await client.query('SELECT id,epoch,"isOpen","openKey" FROM "ScanAuthorityEpoch" ORDER BY epoch DESC LIMIT 1');
    const authority=result.rows[0];
    const open=await client.query('SELECT count(*)::int AS count FROM "ScanAuthorityEpoch" WHERE "isOpen"');
    if(!authority||!authority.isOpen||authority.openKey!=='open'||
      authority.id!==process.env.LYRASHIELD_AUTHORITY_EPOCH_ID||open.rows[0]?.count!==1)throw Error();
    console.log(JSON.stringify({epochId:authority.id,epoch:authority.epoch}));
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
})().catch(()=>{process.stderr.write('Runtime epoch unavailable\n');process.exitCode=1});
"""


def require(value):
    if not value:
        raise ValueError("Protected installed runtime authority unavailable")


def verify_controller_role_ids(components, socket_gid):
    require(set(components) == set(ROLES))
    for identity in components.values():
        require(type(identity["uid"]) is int and identity["uid"] > 0)
        require(type(identity["gid"]) is int and identity["gid"] > 0)
    require(len({value["uid"] for value in components.values()}) == len(ROLES))
    supervisor_gid = components["supervisor"]["gid"]
    require(supervisor_gid == socket_gid)
    require(
        all(
            components[role]["gid"] != supervisor_gid
            for role in ROLES
            if role != "supervisor"
        )
    )


def verify_process_identity(status, identity):
    require(
        status["Uid"].split() == [str(identity["uid"])] * 4
        and status["Gid"].split() == [str(identity["gid"])] * 4
        and set(status["Groups"].split()) <= {str(identity["gid"])}
    )


def installed_native_census(authority):
    """Only root ledger entries whose complete live native config still matches."""
    path = Path("/opt/lyrashield/runtime-control/native-executor.py")
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022)
    spec = importlib.util.spec_from_file_location("installed_native_census", path)
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    ids = native.allowed_native_containers(authority)
    require(len(ids) <= 10000 and len(set(ids)) == len(ids))
    require(all(re.fullmatch(r"[a-f0-9]{64}", value) for value in ids))
    return set(ids)


def verify_preparation_delegation(policy, authority, pin):
    if policy["schema"] == "lyrashield-runtime-host-policy/1":
        require(set(policy) == {"schema", "network", "components", "journalSealControl"})
        return None
    require(policy["schema"] == "lyrashield-runtime-host-policy/2")
    require(set(policy) == {"schema", "network", "components", "journalSealControl", "preparation"})
    delegation = policy["preparation"]
    require(set(delegation) == {
        "schema", "purpose", "issuerKeyId", "issuerKeyHash", "publicKey",
        "preparationPolicyChecksum", "productRevision", "workflow", "authorityEpochId",
        "epoch", "targetTypes", "scanWorkflows", "issuedAt", "expiresAt", "maxStagingLifetimeMs",
    })
    require(delegation["schema"] == "lyrashield-preparation-delegation/1")
    require(delegation["purpose"] == "scan-preparation")
    require(delegation["workflow"] == ".github/workflows/issue-runtime-qualification.yml")
    require(delegation["productRevision"] == authority["productRevision"])
    require(delegation["authorityEpochId"] == authority["epochId"] and delegation["epoch"] == authority["epoch"])
    require(delegation["targetTypes"] == ["REPO"])
    require(delegation["scanWorkflows"] == ["REVIEW_TARGET", "REVIEW_CHANGES"])
    require(delegation["maxStagingLifetimeMs"] == 900000)
    issued_date = datetime.fromisoformat(delegation["issuedAt"].replace("Z", "+00:00"))
    expires_date = datetime.fromisoformat(delegation["expiresAt"].replace("Z", "+00:00"))
    require(issued_date.tzinfo is not None and expires_date.tzinfo is not None)
    require(0 < expires_date.timestamp() - issued_date.timestamp() <= 86400)
    issuer = urlsplit(delegation["issuerKeyId"])
    require(issuer.scheme == "https" and issuer.netloc and not issuer.username and not issuer.password)
    require(delegation["issuerKeyId"] != pin["keyId"])
    public = public_der({"algorithm": "RS256", "publicKey": delegation["publicKey"]})
    require(checksum(public)[7:] == delegation["issuerKeyHash"])
    require(public != public_der(pin))
    require(public != public_der(authority["sandboxGrantSigner"]))
    github = read_preparation_github_env()
    github_public = output(["openssl", "pkey", "-pubout", "-outform", "DER"],
        input_bytes=github["GITHUB_APP_PRIVATE_KEY"].replace("\\n", "\n").encode(), limit=1024)
    require(len(github_public) >= 294 and bytes.fromhex("06092a864886f70d010101") in github_public)
    require(github_public not in (public, public_der(pin), public_der(authority["sandboxGrantSigner"])))
    broker_environment = policy["components"]["broker"]["environment"]
    require(broker_environment.get("LYRASHIELD_PREPARATION_GITHUB_APP_ID") == github["GITHUB_APP_ID"])
    require(broker_environment.get("LYRASHIELD_PREPARATION_GITHUB_KEY_SHA256") == checksum(github_public)[7:])
    read_preparation_evidence_env(policy)
    preparation_path = ROOT / "preparation-host-policy.json"
    private_path = ROOT / "control" / "preparation-grant-key.pem"
    public_path = ROOT / "control" / "preparation-public-key.pem"
    for path in (preparation_path, private_path, public_path):
        require(stat.S_IMODE(path.lstat().st_mode) == 0o400)
    raw = read_private(preparation_path, 65536)
    require(checksum(raw)[7:] == delegation["preparationPolicyChecksum"])
    preparation = json.loads(raw)
    require(canonical(preparation).encode() == raw)
    require(preparation["schema"] == "lyrashield-preparation-host-policy/2")
    require(preparation["executionContext"] == {"environment": "PRODUCTION"})
    require(preparation["issuerKeyHash"] == delegation["issuerKeyHash"])
    require(preparation["issuerKeyId"] == delegation["issuerKeyId"])
    require(preparation["authorityEpochId"] == authority["epochId"])
    require(preparation["productRevision"] == authority["productRevision"])
    require(preparation["engineRevision"] == authority["engineRevision"])
    require(preparation["network"] == policy["network"])
    require(preparation["engineImage"] == "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@" + authority["workerDigest"])
    require(preparation["sandboxImage"] == "ghcr.io/ecryptoguru/lyrashield-sandbox@" + authority["sandboxDigest"])
    require(output(["openssl", "pkey", "-pubout", "-outform", "DER"],
        input_bytes=read_private(private_path), limit=1024) == public)
    require(output(["openssl", "pkey", "-pubin", "-outform", "DER"],
        input_bytes=read_private(public_path), limit=1024) == public)
    return delegation


def read_preparation_github_env():
    path = ROOT / "control/preparation-github.env"
    require(stat.S_IMODE(path.lstat().st_mode) == 0o400)
    values = {}
    for line in read_private(path, 8192).decode().splitlines():
        name, separator, value = line.partition("=")
        require(separator and name not in values and name in ("GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"))
        require(value and "\0" not in value)
        values[name] = value
    require(set(values) == {"GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"})
    require(re.fullmatch(r"[1-9][0-9]*", values["GITHUB_APP_ID"]))
    require(values["GITHUB_APP_PRIVATE_KEY"].startswith("-----BEGIN "))
    return values



def read_preparation_evidence_env(policy):
    path = ROOT / "control/preparation-evidence.env"
    require(stat.S_IMODE(path.lstat().st_mode) == 0o400)
    raw = read_private(path, 16384)
    require(policy["components"]["broker"]["environment"].get("LYRASHIELD_PREPARATION_EVIDENCE_CONFIG_SHA256") == checksum(raw)[7:])
    allowed = {"S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "LYRASHIELD_EVIDENCE_KEK", "LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF", "LYRASHIELD_EVIDENCE_KEK_KEYRING"}
    values = {}
    for line in raw.decode().splitlines():
        name, separator, value = line.partition("=")
        require(separator and name not in values and name in allowed and value and "\0" not in value)
        values[name] = value
    require({"S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF"} <= set(values))
    require("LYRASHIELD_EVIDENCE_KEK" in values or "LYRASHIELD_EVIDENCE_KEK_KEYRING" in values)
    endpoint = urlsplit(values["S3_ENDPOINT"])
    require(endpoint.scheme == "https" and endpoint.hostname and not endpoint.username and not endpoint.password)
    return values

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def checksum(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def read_private(path, limit=16384, *, public_gid=None):
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(
            stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
        )
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1)
        modes = (0o400, 0o600) if public_gid is None else (0o440,)
        require(stat.S_IMODE(info.st_mode) in modes and info.st_size <= limit)
        require(public_gid is None or info.st_gid == public_gid)
        raw = os.read(descriptor, limit + 1)
        current = os.fstat(descriptor)
        attributes = (
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
        require(
            len(raw) <= limit
            and all(
                getattr(current, name) == getattr(info, name) for name in attributes
            )
        )
        return raw
    finally:
        os.close(descriptor)


def output(args, limit=131072, input_bytes=None):
    def bounded_child():
        resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))

    with tempfile.TemporaryFile() as stream:
        subprocess.run(
            args,
            input=input_bytes,
            stdout=stream,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=15,
            preexec_fn=bounded_child,
        )
        stream.seek(0)
        raw = stream.read(limit + 1)
        require(len(raw) <= limit)
        return raw


def der(tag, value):
    size = len(value)
    length = (
        bytes([size])
        if size < 128
        else bytes([0x80 + (size.bit_length() + 7) // 8])
        + size.to_bytes((size.bit_length() + 7) // 8, "big")
    )
    return bytes([tag]) + length + value


def public_der(pin):
    require(pin["algorithm"] == "RS256")
    public = pin["publicKey"]
    require(
        set(public) == {"kty", "n", "e"}
        and public["kty"] == "RSA"
        and public["e"] == "AQAB"
    )
    modulus = base64.urlsafe_b64decode(public["n"] + "=" * (-len(public["n"]) % 4))
    require(
        len(modulus) == 384
        and modulus[0] & 0x80
        and base64.urlsafe_b64encode(modulus).decode().rstrip("=") == public["n"]
    )
    integers = der(2, b"\0" + modulus) + der(2, b"\x01\x00\x01")
    public_key = der(0x30, integers)
    spki = der(
        0x30,
        bytes.fromhex("300d06092a864886f70d0101010500") + der(3, b"\0" + public_key),
    )
    return spki


def public_pem(pin):
    spki = public_der(pin)
    encoded = base64.b64encode(spki).decode()
    return (
        "-----BEGIN PUBLIC KEY-----\n"
        + "\n".join(encoded[i : i + 64] for i in range(0, len(encoded), 64))
        + "\n-----END PUBLIC KEY-----\n"
    )


def verify_envelope(raw, pin, expected, now):
    envelope = json.loads(raw)
    require(set(envelope) == {"raw", "result"})
    signed = envelope["result"]
    require(set(signed) == {"algorithm", "keyId", "signature"})
    require(signed["algorithm"] == "RS256" and signed["keyId"] == pin["keyId"])
    record_raw = envelope["raw"].encode()
    record = json.loads(record_raw)
    require(record_raw.decode() == canonical(record))
    require(
        set(record)
        == set(FIELDS)
        | {
            "schema",
            "purpose",
            "epochId",
            "epoch",
            "issuedAt",
            "acceptanceDigest",
            "sandboxGrantSigner",
            "toolChannel",
            "issuer",
        }
    )
    require(record["schema"] == "lyrashield-installed-runtime-authority/1")
    require(record["purpose"] == "launch-qualified-controller")
    require(IDENTIFIER.fullmatch(record["epochId"]) and ".." not in record["epochId"])
    require(type(record["epoch"]) is int and 0 < record["epoch"] <= 2147483647)
    require(type(record["issuedAt"]) is int and 0 < record["issuedAt"] <= now)
    require(DIGEST.fullmatch(record["acceptanceDigest"]))
    require(set(expected) == set(FIELDS))
    for field in FIELDS:
        pattern = REVISION if field.endswith("Revision") else DIGEST
        require(pattern.fullmatch(record[field]) and record[field] == expected[field])
    issuer = record["issuer"]
    require(
        set(issuer)
        == {
            "repositoryId",
            "repositoryOwnerId",
            "workflow",
            "source",
            "runId",
            "attempt",
        }
    )
    require(
        issuer["repositoryId"] == "1286618458"
        and issuer["repositoryOwnerId"] == "116722580"
    )
    require(
        issuer["workflow"] == ".github/workflows/issue-runtime-qualification.yml"
        and issuer["source"] == record["productRevision"]
    )
    require(
        all(
            isinstance(issuer[key], str)
            and re.fullmatch(r"[1-9][0-9]{0,19}", issuer[key])
            for key in ("runId", "attempt")
        )
    )
    channel = record["toolChannel"]
    require(set(channel) == {"schema", "origin"})
    require(channel["schema"] == "lyrashield-sandbox-tool-channel/1")
    origin = channel["origin"]
    require(isinstance(origin, str) and len(origin) <= 256)
    parsed = urlsplit(origin)
    require(
        parsed.scheme == "https"
        and parsed.hostname is not None
        and re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", parsed.hostname)
        and all(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part)
            for part in parsed.hostname.split(".")
        )
        and parsed.username is None
        and parsed.password is None
        and parsed.path == ""
        and not parsed.query
        and not parsed.fragment
        and (parsed.port is None or 0 < parsed.port <= 65535)
        and origin
        == "https://"
        + parsed.hostname
        + (":" + str(parsed.port) if parsed.port else "")
        and parsed.port != 443
    )
    signer = record["sandboxGrantSigner"]
    require(
        set(signer)
        == {
            "schema",
            "purpose",
            "algorithm",
            "keyId",
            "epochId",
            "epoch",
            "publicKey",
            "publicKeySha256",
        }
    )
    require(
        signer["schema"] == "lyrashield-sandbox-grant-signer/1"
        and signer["purpose"] == "sandbox-tool-grants"
        and signer["algorithm"] == "RS256"
    )
    require(
        isinstance(signer["keyId"], str)
        and IDENTIFIER.fullmatch(signer["keyId"])
        and signer["keyId"] != pin["keyId"]
    )
    require(
        signer["epochId"] == record["epochId"] and signer["epoch"] == record["epoch"]
    )
    delegated_public = public_der(signer)
    require(signer["publicKeySha256"] == checksum(delegated_public))
    require(delegated_public != public_der(pin))
    signature = base64.b64decode(signed["signature"], validate=True)
    require(
        len(signature) == 384
        and base64.b64encode(signature).decode() == signed["signature"]
    )
    with tempfile.TemporaryDirectory(prefix="lyrashield-authority-") as directory:
        root = Path(directory)
        (root / "key.pem").write_text(public_pem(pin))
        (root / "signature").write_bytes(signature)
        output(
            [
                "openssl",
                "dgst",
                "-sha256",
                "-verify",
                str(root / "key.pem"),
                "-signature",
                str(root / "signature"),
            ],
            input_bytes=record_raw,
            limit=256,
        )
    return record


def inspect_image(reference, revision, source, *, disposable=False):
    require(
        re.fullmatch(
            r"127\.0\.0\.1:5000/lyrashield-fixture/(?:broker|supervisor|provider-gateway|worker|sandbox)@sha256:[a-f0-9]{64}", reference
        ) if disposable else re.fullmatch(
            r"ghcr\.io/ecryptoguru/(?:lyrashield-ai/lyrashield-(?:broker|supervisor|provider-gateway|worker)|lyrashield-sandbox)@sha256:[a-f0-9]{64}",
            reference,
        )
    )
    rows = json.loads(output(["docker", "image", "inspect", reference]))
    require(len(rows) == 1)
    image = rows[0]
    require(reference in image["RepoDigests"])
    labels = image["Config"].get("Labels") or {}
    require(labels.get("org.opencontainers.image.revision") == revision)
    require(labels.get("org.opencontainers.image.source") == source)
    require(DIGEST.fullmatch(image["Id"]))
    return image


def verify_container(container, image, reference, identity, network, *, retained_cleanup=False):
    require(type(retained_cleanup) is bool)
    if retained_cleanup:
        require(re.fullmatch(r"ghcr\.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:[a-f0-9]{64}", reference))
    config, host, state = (
        container["Config"],
        container["HostConfig"],
        container["State"],
    )
    require(
        state["Running"] is True
        and not state.get("Paused")
        and not state.get("Restarting")
    )
    health = state.get("Health", {}).get("Status")
    require(health in {"healthy", "unhealthy", "starting"} if retained_cleanup else health == "healthy")
    require(container["Image"] == image["Id"] and config["Image"] == reference)
    require(
        config.get("Entrypoint") == image["Config"].get("Entrypoint")
        and config.get("Cmd") == image["Config"].get("Cmd")
    )
    require(
        set(identity)
        == {"uid", "gid", "environment", "credentialFiles", "processCommand"}
    )
    require(
        type(identity["uid"]) is int
        and identity["uid"] > 0
        and type(identity["gid"]) is int
        and identity["gid"] > 0
    )
    require(config["User"] == str(identity["uid"]) + ":" + str(identity["gid"]))
    require(
        host["ReadonlyRootfs"] is True
        and host["Privileged"] is False
        and host.get("CapDrop") == ["ALL"]
    )
    require(
        not host.get("CapAdd")
        and set(host.get("SecurityOpt") or []) == {"no-new-privileges"}
    )
    require(
        not host.get("PidMode")
        and not host.get("IpcMode") == "host"
        and not host.get("PortBindings")
        and not any(
            host.get(key)
            for key in (
                "Devices",
                "DeviceRequests",
                "DeviceCgroupRules",
                "GroupAdd",
                "VolumesFrom",
            )
        )
    )
    require(set(container["NetworkSettings"]["Networks"]) == {network})
    require(type(state["Pid"]) is int and state["Pid"] > 1)
    return state


def component(role, policy, authority, *, fixture_reference=None, retained_cleanup=False):
    require(type(retained_cleanup) is bool)
    if retained_cleanup:
        require(role == "worker" and fixture_reference is None
                and authority.get("schema") == "lyrashield-installed-runtime-authority/1"
                and authority.get("purpose") == "launch-qualified-controller")
    name = "lyrashield-" + role
    digest_field = (
        "providerGatewayDigest" if role == "provider-gateway" else role + "Digest"
    )
    reference = (
        "ghcr.io/ecryptoguru/lyrashield-ai/" + name + "@" + authority[digest_field]
    )
    if fixture_reference is not None:
        require(authority.get("schema") == "lyrashield-disposable-native-authority/1"
                and authority.get("purpose") == "disposable-linux-native-tests")
        require(fixture_reference == "127.0.0.1:5000/lyrashield-fixture/" + role + "@" + authority[digest_field])
        reference = fixture_reference
    image = inspect_image(
        reference,
        authority["productRevision"],
        "https://github.com/ecryptoguru/lyrashield-ai",
        disposable=fixture_reference is not None,
    )
    rows = json.loads(output(["docker", "inspect", "--type", "container", name]))
    require(len(rows) == 1)
    container = rows[0]
    identity = policy["components"][role]
    state = verify_container(container, image, reference, identity, policy["network"], retained_cleanup=retained_cleanup)
    process = Path("/proc") / str(state["Pid"])
    status = dict(
        line.split(":", 1)
        for line in (process / "status").read_text().splitlines()
        if ":" in line
    )
    verify_process_identity(status, identity)
    command = identity["processCommand"]
    require(
        isinstance(command, list)
        and 0 < len(command) <= 32
        and all(isinstance(value, str) and 0 < len(value) <= 2048 for value in command)
    )
    require(
        (process / "cmdline").read_bytes().split(b"\0")[:-1]
        == [value.encode() for value in command]
    )
    environment = {}
    raw = (process / "environ").read_bytes()
    require(len(raw) <= 131072)
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        key, value = entry.decode().split("=", 1)
        require(key not in environment)
        environment[key] = value
    fixed_keys = {
        "HOSTNAME",
        "LYRASHIELD_AUTHORITY_EPOCH_ID",
        "LYRASHIELD_RUNTIME_POLICY_DIGEST",
        "LYRASHIELD_PRODUCT_REVISION",
    }
    declared_keys = {
        entry.split("=", 1)[0] for entry in image["Config"].get("Env") or []
    }
    declared_keys.update(identity["environment"])
    declared_keys.update(identity["credentialFiles"])
    require(set(environment) <= declared_keys | fixed_keys)
    require(
        not any(
            (re.search(r"(KEY|TOKEN|SECRET)$", key) and key not in ("LYRASHIELD_SANDBOX_GRANT_PUBLIC_KEY", "LYRASHIELD_SUPERVISOR_ATTEMPT_PROOF_PUBLIC_KEY"))
            or key in ("DATABASE_URL", "DATABASE_SYSTEM_URL")
            for key in identity["environment"]
        )
    )
    require(environment.get("LYRASHIELD_AUTHORITY_EPOCH_ID") == authority["epochId"])
    require(
        environment.get("LYRASHIELD_RUNTIME_POLICY_DIGEST")
        == authority["runtimePolicyDigest"]
    )
    require(
        environment.get("LYRASHIELD_PRODUCT_REVISION") == authority["productRevision"]
    )
    for key, value in identity["environment"].items():
        require(
            isinstance(key, str)
            and isinstance(value, str)
            and environment.get(key) == value
        )
    require(
        environment.get("DOCKER_HOST") is None
        and environment.get("DATABASE_SYSTEM_URL") is None
    )
    if role == "worker":
        require(environment.get("TOOL_URL") is None if fixture_reference is not None else environment.get("TOOL_URL") == authority["toolChannel"]["origin"])
    if role == "broker" and policy["schema"] == "lyrashield-runtime-host-policy/2":
        require(identity["credentialFiles"].get("LYRASHIELD_PREPARATION_SOURCE_DATABASE_URL") == str(ROOT / "control/preparation-source-database-url.txt"))
    if role == "supervisor":
        sandbox_public = environment.get("LYRASHIELD_SANDBOX_GRANT_PUBLIC_KEY")
        require(isinstance(sandbox_public, str))
        sandbox_pin = authority.get("sandboxGrantSigner")
        if fixture_reference is not None:
            fixture_pin_path = ROOT / "disposable-native-pin.json"
            require(stat.S_IMODE(fixture_pin_path.lstat().st_mode) == 0o400)
            sandbox_pin = json.loads(read_private(fixture_pin_path, 4096))
            require(set(sandbox_pin) == {"purpose", "algorithm", "keyId", "publicKey"} and sandbox_pin["purpose"] == authority["purpose"] and sandbox_pin["keyId"].startswith("disposable-") and sandbox_pin["algorithm"] == "RS256")
        require(environment.get("LYRASHIELD_SANDBOX_GRANT_KEY_ID") == sandbox_pin["keyId"])
        require(output(["openssl", "pkey", "-pubin", "-outform", "DER"], input_bytes=sandbox_public.encode(), limit=1024) == public_der(sandbox_pin))
    if role != "provider-gateway":
        require(
            not any(
                re.search(
                    r"^(OPENAI|AZURE_OPENAI|ANTHROPIC|GOOGLE|GEMINI|COHERE|MISTRAL|DEEPSEEK).*?(KEY|TOKEN|SECRET)$",
                    key,
                )
                for key in environment
            )
        )
    private_proof_key = "LYRASHIELD_SUPERVISOR_ATTEMPT_PROOF_PRIVATE_KEY"
    for key, value in environment.items():
        if "PRIVATE KEY-----" not in value:
            continue
        require(role == "supervisor" and key == private_proof_key)
        private_path = ROOT / "control/supervisor-attempt-proof-key.pem"
        require(identity["credentialFiles"].get(key) == str(private_path))
        require(stat.S_IMODE(private_path.lstat().st_mode) == 0o400)
        private_bytes = read_private(private_path, 4096)
        require(private_bytes.decode().strip() == value)
        public_pem = identity["environment"].get("LYRASHIELD_SUPERVISOR_ATTEMPT_PROOF_PUBLIC_KEY")
        require(isinstance(public_pem, str) and environment.get("LYRASHIELD_SUPERVISOR_ATTEMPT_PROOF_PUBLIC_KEY") == public_pem)
        public = output(["openssl", "pkey", "-pubout", "-outform", "DER"], input_bytes=private_bytes, limit=128)
        # Ed25519 SPKI is exactly this fixed algorithm header and a 32-byte key.
        require(len(public) == 44 and public[:12] == bytes.fromhex("302a300506032b6570032100"))
        require(output(["openssl", "pkey", "-pubin", "-outform", "DER"], input_bytes=public_pem.encode(), limit=128) == public)
    require(all(key in identity["credentialFiles"] for key in CONTROL_KEYS[role]))
    for key, path in identity["credentialFiles"].items():
        credential_path = Path(path)
        require(
            credential_path.parent == ROOT / "control"
            and credential_path != ROOT / "control/sandbox-grant-key.pem"
            and re.fullmatch(r"[a-z0-9-]+\.[a-z0-9-]+", credential_path.name)
        )
        credential = read_private(credential_path, 4096).decode().strip()
        require(len(credential.encode()) >= 32 and environment.get(key) == credential)
    mounts = container.get("Mounts") or []
    require(
        any(
            mount["Source"] == str(ROOT / "runtime-policy.json")
            and mount["Destination"] == str(ROOT / "runtime-policy.json")
            and mount["RW"] is False
            for mount in mounts
        )
    )
    for mount in mounts:
        if role == "broker" and policy["schema"] == "lyrashield-runtime-host-policy/2":
            destination = Path(mount["Destination"])
            # Root acquisition executes this image closure; host mounts cannot replace its code, ABI or TLS roots.
            immutable_roots = tuple(Path(value) for value in ("/app", "/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc/ssl", "/opt/lyrashield-controller"))
            require(str(destination).startswith("/") and ".." not in destination.parts and "." not in destination.parts)
            require(destination != Path("/") and not any(destination == root or root in destination.parents or destination in root.parents for root in immutable_roots))
        source = Path(mount["Source"])
        preparation_copies = {
            ROOT / "control/broker/preparation-host-policy.public.json": "/opt/lyrashield-runtime/preparation-host-policy.json",
            ROOT / "control/broker/preparation-public-key.pub.pem": "/opt/lyrashield-runtime/preparation-public-key.pem",
        }
        public_preparation = role == "broker" and source in preparation_copies
        fixture_copies = {
            ROOT / "disposable-native-authority.json": "/opt/lyrashield/control/disposable-native-authority.json",
            ROOT / "runtime-policy.json": "/opt/lyrashield/control/disposable-runtime-policy.json",
            ROOT / "disposable-native-context.json": "/opt/lyrashield/control/disposable-native-context.json",
            ROOT / "disposable-native-pin.json": "/opt/lyrashield/control/disposable-native-pin.json",
            ROOT / "control/disposable-sandbox-grant-key.pem": "/opt/lyrashield/control/disposable-sandbox-grant-key.pem",
        }
        fixture_copy = fixture_reference is not None and role == "supervisor" and source in fixture_copies and mount["Destination"] == fixture_copies[source]
        if fixture_copy:
            metadata = source.lstat()
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_nlink == 1 and stat.S_IMODE(metadata.st_mode) == 0o400 and mount["RW"] is False)
        require(
            source == ROOT / "runtime-policy.json"
            or source.parent == ROOT / "control"
            or source.parent == Path("/var/lib/lyrashield/controller")
            or source.parent == Path("/run/lyrashield/control")
            or public_preparation
            or fixture_copy
        )
        require(
            "docker.sock" not in str(source)
            and source != ROOT / "control/sandbox-grant-key.pem"
            and source != ROOT / "control/preparation-grant-key.pem"
            and (source != ROOT / "control/disposable-sandbox-grant-key.pem" or fixture_copy)
        )
        if public_preparation:
            metadata = source.lstat()
            parent = source.parent.lstat()
            require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and parent.st_gid == identity["gid"] and stat.S_IMODE(parent.st_mode) == 0o750)
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_gid == identity["gid"] and metadata.st_nlink == 1 and stat.S_IMODE(metadata.st_mode) == 0o440)
            require(mount["RW"] is False and mount["Destination"] == preparation_copies[source])
            require(policy["schema"] == "lyrashield-runtime-host-policy/2")
            public_bytes = read_private(source, 65536, public_gid=identity["gid"])
            if source.name.endswith(".json"):
                require(checksum(public_bytes)[7:] == policy["preparation"]["preparationPolicyChecksum"])
            else:
                require(checksum(output(["openssl", "pkey", "-pubin", "-outform", "DER"], input_bytes=public_bytes, limit=1024))[7:] == policy["preparation"]["issuerKeyHash"])
        if source.parent == Path("/run/lyrashield/control"):
            metadata = source.lstat()
            require(
                stat.S_ISSOCK(metadata.st_mode)
                and metadata.st_uid == 0
                and metadata.st_gid == identity["gid"]
                and stat.S_IMODE(metadata.st_mode) == 0o660
                and mount["RW"] is False
            )
        if mount["RW"]:
            require(source == Path("/var/lib/lyrashield/controller") / role)
            metadata = source.lstat()
            require(
                stat.S_ISDIR(metadata.st_mode)
                and metadata.st_uid == identity["uid"]
                and stat.S_IMODE(metadata.st_mode) == 0o700
            )
    mounted_policy = process / "root" / "etc/lyrashield/runtime-policy.json"
    require(checksum(mounted_policy.read_bytes()) == authority["runtimePolicyDigest"])
    return {
        "id": container["Id"],
        "imageId": image["Id"],
        "pid": state["Pid"],
        "startedAt": state["StartedAt"],
        "uid": identity["uid"],
        "gid": identity["gid"],
    }


def observe(expected, pin):
    envelope_raw = read_private(ROOT / "runtime-authority.json")
    authority = verify_envelope(envelope_raw, pin, expected, int(time.time()))
    grant_key = ROOT / "control/sandbox-grant-key.pem"
    private_grant_key = read_private(grant_key, 8192)
    grant_key_metadata = grant_key.lstat()
    require(
        grant_key_metadata.st_gid == 0
        and stat.S_IMODE(grant_key_metadata.st_mode) == 0o400
    )
    require(
        output(
            ["openssl", "pkey", "-pubout", "-outform", "DER"],
            input_bytes=private_grant_key,
            limit=1024,
        )
        == public_der(authority["sandboxGrantSigner"])
    )
    policy_raw = read_private(ROOT / "runtime-policy.json", 65536)
    require(checksum(policy_raw) == authority["runtimePolicyDigest"])
    policy = json.loads(policy_raw)
    verify_preparation_delegation(policy, authority, pin)
    load_seal_gate_configuration(authority["productRevision"], pin)
    require(
        policy["schema"] in ("lyrashield-runtime-host-policy/1", "lyrashield-runtime-host-policy/2")
        and set(policy["components"]) == set(ROLES)
    )
    require(re.fullmatch(r"lyrashield-runtime-[a-z0-9-]{1,40}", policy["network"]))
    networks = json.loads(output(["docker", "network", "inspect", policy["network"]]))
    require(len(networks) == 1 and networks[0]["Internal"] is True)
    verify_controller_role_ids(
        policy["components"], grp.getgrnam("lyrashield-supervisor").gr_gid
    )
    first = {role: component(role, policy, authority) for role in ROLES}

    def census():
        native_ids = installed_native_census(authority)
        ids = (
            output(["docker", "ps", "--quiet", "--no-trunc"], limit=1024 * 1024)
            .decode()
            .split()
        )
        require(
            set(ids) == {value["id"] for value in first.values()} | native_ids
            and len(ids) == len(ROLES) + len(native_ids)
        )

    census()
    sandbox = inspect_image(
        "ghcr.io/ecryptoguru/lyrashield-sandbox@" + authority["sandboxDigest"],
        authority["engineRevision"],
        "https://github.com/ecryptoguru/lyrashield-engine",
    )

    epoch = json.loads(
        output(
            ["docker", "exec", "lyrashield-broker", "node", "-e", EPOCH_PROBE],
            limit=1024,
        )
    )
    require(epoch == {"epochId": authority["epochId"], "epoch": authority["epoch"]})
    second = {role: component(role, policy, authority) for role in ROLES}
    require(
        json.loads(
            output(
                ["docker", "exec", "lyrashield-broker", "node", "-e", EPOCH_PROBE],
                limit=1024,
            )
        )
        == epoch
    )
    census()
    require(
        json.loads(output(["docker", "network", "inspect", policy["network"]]))
        == networks
    )
    require(
        inspect_image(
            "ghcr.io/ecryptoguru/lyrashield-sandbox@" + authority["sandboxDigest"],
            authority["engineRevision"],
            "https://github.com/ecryptoguru/lyrashield-engine",
        )
        == sandbox
    )
    require(
        first == second
        and read_private(ROOT / "runtime-authority.json") == envelope_raw
    )
    require(read_private(ROOT / "runtime-policy.json", 65536) == policy_raw)
    require(read_private(grant_key, 8192) == private_grant_key)
    return {
        "schema": "lyrashield-installed-runtime-observation/1",
        "authorityDigest": checksum(envelope_raw),
        "runtimePolicyDigest": checksum(policy_raw),
        "epochId": authority["epochId"],
        "epoch": authority["epoch"],
        "identitiesDigest": checksum(canonical(first).encode()),
        "sandboxImageId": sandbox["Id"],
    }


def load_execution_authority(pin):
    """Protected installed purpose only; staged metadata is not live authority."""
    envelope_raw = read_private(ROOT / "runtime-authority.json")
    unsigned = json.loads(json.loads(envelope_raw)["raw"])
    expected = {field: unsigned[field] for field in FIELDS}
    authority = verify_envelope(envelope_raw, pin, expected, int(time.time()))
    observation = observe(expected, pin)
    control = load_seal_gate_configuration(authority["productRevision"], pin)
    require(observation["authorityDigest"] == checksum(envelope_raw))
    require(observation["runtimePolicyDigest"] == control["runtimePolicyDigest"])
    require(read_private(ROOT / "runtime-authority.json") == envelope_raw)
    result = {
        "purpose": "production-installed",
        "epochId": authority["epochId"],
        "epoch": authority["epoch"],
        "sourceRevision": authority["productRevision"],
        "runtimePolicyDigest": observation["runtimePolicyDigest"],
        "authorityDigest": observation["authorityDigest"],
        "supervisorInstanceId": control["supervisorInstanceId"],
    }
    policy = json.loads(read_private(ROOT / "runtime-policy.json", 65536))
    delegation = verify_preparation_delegation(policy, authority, pin)
    if delegation is not None:
        result["preparation"] = delegation
    return result


def load_seal_gate_configuration(source, pin, stream="controller"):
    require(stream in ("controller", "tools"))
    require(REVISION.fullmatch(source))
    envelope_raw = read_private(ROOT / "runtime-authority.json")
    unsigned = json.loads(json.loads(envelope_raw)["raw"])
    expected = {field: unsigned[field] for field in FIELDS}
    authority = verify_envelope(envelope_raw, pin, expected, int(time.time()))
    require(authority["productRevision"] == source)
    policy_raw = read_private(ROOT / "runtime-policy.json", 65536)
    require(checksum(policy_raw) == authority["runtimePolicyDigest"])
    policy = json.loads(policy_raw)
    require(policy["schema"] in ("lyrashield-runtime-host-policy/1", "lyrashield-runtime-host-policy/2"))
    verify_preparation_delegation(policy, authority, pin)
    main_control = policy["journalSealControl"]
    control = main_control if stream == "controller" else json.loads(
        policy["components"]["supervisor"]["environment"]["LYRASHIELD_TOOL_JOURNAL_SEAL_CONTROL_JSON"]
    )
    if stream == "tools":
        require(len({control["originalKeyHash"], control["wrapperKeyHash"], control["checkpointKeyHash"]}) == 3)
        require(control["streamId"] == main_control["streamId"] + ".tools")
        require(control["supervisorInstanceId"] == main_control["supervisorInstanceId"] + ".tools")
        for name in ("originalKeyHash", "wrapperKeyHash", "checkpointKeyHash", "controlCredentialId", "genesisRecordHash"):
            require(control[name] != main_control[name])
        require((control["controlAccountId"], control["controlBucket"]) != (main_control["controlAccountId"], main_control["controlBucket"]))
    require(
        set(control)
        == {
            "schema",
            "productRevision",
            "epochId",
            "epoch",
            "streamId",
            "supervisorInstanceId",
            "originalKeyHash",
            "wrapperKeyHash",
            "checkpointKeyHash",
            "controlAccountId",
            "controlBucket",
            "genesisRecordHash",
            "databaseRole",
            "controlCredentialId",
        }
    )
    require(control["schema"] == "lyrashield-journal-seal-control/1")
    require(re.fullmatch(r"[a-z][a-z0-9_]{2,62}", control["databaseRole"]))
    require(
        control["productRevision"] == source
        and control["epochId"] == authority["epochId"]
        and control["epoch"] == authority["epoch"]
    )
    for name in ("streamId", "supervisorInstanceId"):
        require(IDENTIFIER.fullmatch(control[name]) and ".." not in control[name])
    for name in (
        "originalKeyHash",
        "wrapperKeyHash",
        "checkpointKeyHash",
        "genesisRecordHash",
    ):
        require(re.fullmatch(r"[a-f0-9]{64}", control[name]))
    require(re.fullmatch(r"[a-f0-9]{32}", control["controlAccountId"]))
    require(re.fullmatch(r"[a-f0-9]{32}", control["controlCredentialId"]))
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", control["controlBucket"]))
    require(
        control["controlBucket"]
        not in {
            "lyrashield-authority-journal",
            "lyrashield-production-backups",
            "lyrashield-production-evidence",
        }
    )
    require(
        read_private(ROOT / "runtime-authority.json") == envelope_raw
        and read_private(ROOT / "runtime-policy.json", 65536) == policy_raw
    )
    return {
        **control,
        "authorityDigest": checksum(envelope_raw),
        "runtimePolicyDigest": checksum(policy_raw),
    }


if __name__ == "__main__":
    try:
        require(os.geteuid() == 0 and len(sys.argv) == 3)
        require(len(sys.argv[1]) <= 6000)
        pin = json.loads(Path(sys.argv[2]).read_text())
        if sys.argv[1] == "execution-authority":
            print(canonical(load_execution_authority(pin)))
        elif sys.argv[1].startswith("tool-seal-gate:"):
            print(canonical(load_seal_gate_configuration(sys.argv[1][15:], pin, "tools")))
        elif sys.argv[1].startswith("seal-gate:"):
            print(canonical(load_seal_gate_configuration(sys.argv[1][10:], pin)))
        else:
            expected = json.loads(base64.b64decode(sys.argv[1], validate=True))
            print(canonical(observe(expected, pin)))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print("Protected installed runtime authority unavailable", file=sys.stderr)
        sys.exit(1)
