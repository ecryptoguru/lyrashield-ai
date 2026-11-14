"""Observe task-owned disposable Docker fixtures; never issue qualification."""

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import urllib.request
from urllib.parse import parse_qsl, unquote, urlsplit
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
LABEL = "lyrashield.dispatch-authority-fixture"
PROVIDER_SOURCE = HERE / "synthetic_provider.sh"
RELAY_SOURCE = HERE / "relay.py"
FAULT_RELAY_SOURCE = (
    HERE.parents[2] / "packages/db/scripts/tests/dispatch-authority-relay.py"
)
ID = re.compile(r"^[a-f0-9]{64}$")
IMAGE = re.compile(r"^sha256:[a-f0-9]{64}$")
OWNER = re.compile(r"^[a-f0-9]{32,64}$")
BOOT = re.compile(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
TIME_NS = re.compile(r"^time:\[[0-9]+\]$")


def command(*args):
    result = subprocess.run(
        args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15
    )
    return result.stdout.decode("utf-8").strip()


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()


def digest(value):
    return "sha256:" + hashlib.sha256(canonical(value)).hexdigest()


def source_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(container, owner):
    if not ID.fullmatch(container) or not OWNER.fullmatch(owner):
        raise ValueError("fixture identity is invalid")
    result = json.loads(command("docker", "inspect", container))
    if len(result) != 1:
        raise ValueError("fixture inspection is ambiguous")
    item = result[0]
    if (
        item.get("Id") != container
        or not IMAGE.fullmatch(item.get("Image", ""))
        or item.get("Config", {}).get("Labels", {}).get(LABEL) != owner
        or item.get("State", {}).get("Running") is not True
        or not isinstance(item.get("State", {}).get("Pid"), int)
        or item["State"]["Pid"] <= 0
    ):
        raise ValueError("fixture ownership is unavailable")
    return item


def isolated(item):
    networks = item.get("NetworkSettings", {}).get("Networks")
    return (
        item.get("HostConfig", {}).get("NetworkMode") == "none"
        and not item.get("HostConfig", {}).get("PortBindings")
        and isinstance(networks, dict)
        and set(networks) == {"none"}
    )


def fixture_snapshot(item):
    return {
        "id": item["Id"],
        "image": item["Image"],
        "pid": item["State"]["Pid"],
        "startedAt": item["State"]["StartedAt"],
        "network": item["HostConfig"]["NetworkMode"],
        "networks": item["NetworkSettings"]["Networks"],
        "readonly": item["HostConfig"].get("ReadonlyRootfs"),
        "tmpfs": item["HostConfig"].get("Tmpfs"),
        "mounts": item.get("Mounts"),
    }


def linux_identity(container, user=None):
    boot = command(
        "docker", "exec", container, "cat", "/proc/sys/kernel/random/boot_id"
    )
    args = (
        ("docker", "exec", "-u", user, container)
        if user
        else ("docker", "exec", container)
    )
    namespace = command(*args, "readlink", "/proc/1/ns/time")
    if not BOOT.fullmatch(boot) or not TIME_NS.fullmatch(namespace):
        raise ValueError(
            f"Linux boot or time namespace is unavailable: {boot!r}, {namespace!r}"
        )
    return {"bootId": boot, "timeNamespace": namespace}


def relay_database_identity(port, database):
    url = os.environ.get("LYRA_DISPOSABLE_DATABASE_URL", "")
    parsed = urlsplit(url)
    if (
        parsed.scheme not in {"postgres", "postgresql"}
        or parsed.hostname != "127.0.0.1"
        or parsed.port != int(port)
        or unquote(parsed.username or "") != "postgres"
        or not parsed.password
        or unquote(parsed.path) != "/" + database
        or parsed.fragment
        or parse_qsl(parsed.query, keep_blank_values=True)
        not in ([], [("schema", "public")])
    ):
        raise ValueError("disposable database connection differs from owned relay")
    node = shutil.which("node")
    if not node:
        raise ValueError("Node is unavailable")
    code = """const {Client}=require('pg');
    (async()=>{const c=new Client({connectionString:process.env.LYRA_DISPOSABLE_DATABASE_URL});
    await c.connect(); const r=await c.query(\"SELECT system_identifier::text || ':' || d.oid::text AS identity FROM pg_control_system(), pg_database d WHERE d.datname=current_database()\");
    if(r.rows.length!==1)throw Error('database identity unavailable');
    process.stdout.write(r.rows[0].identity); await c.end()})().catch(()=>process.exit(1));"""
    result = subprocess.run(
        [node, "-e", code],
        cwd=HERE.parents[2] / "packages/db",
        env={"PATH": "/usr/bin:/bin", "LYRA_DISPOSABLE_DATABASE_URL": url},
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
    )
    return result.stdout.decode("ascii")


def relay_port(container, relay_pid, port_file, *, allow_fault=False):
    if not isinstance(relay_pid, int) or relay_pid <= 0:
        raise ValueError("relay process identity is invalid")
    relay_args = shlex.split(command("ps", "-p", str(relay_pid), "-o", "command="))
    port_path = Path(port_file).resolve(strict=True)
    allowed_sources = (
        {RELAY_SOURCE, FAULT_RELAY_SOURCE} if allow_fault else {RELAY_SOURCE}
    )
    source = Path(relay_args[1]).resolve() if len(relay_args) >= 4 else None
    if (
        source not in allowed_sources
        or relay_args[2] != container
        or Path(relay_args[3]).resolve() != port_path
    ):
        raise ValueError("relay does not belong to this fixture")
    port = port_path.read_text(encoding="ascii").strip()
    if not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise ValueError("relay port is invalid")
    listeners = command(
        "lsof",
        "-nP",
        "-a",
        "-p",
        str(relay_pid),
        f"-iTCP:{port}",
        "-sTCP:LISTEN",
        "-Fn",
    )
    names = [line[1:] for line in listeners.splitlines() if line.startswith("n")]
    if names != [f"127.0.0.1:{port}"]:
        raise ValueError("relay is not loopback-only")
    return port, source_digest(source)


def observe(
    db_container,
    provider_container,
    owner,
    relay_pid,
    port_file,
    database,
    provider_relay_pid,
    provider_port_file,
):
    if any(
        os.environ.get(name)
        for name in (
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
        )
    ):
        raise ValueError("Docker environment override is not allowed")
    context = command("docker", "context", "show")
    socket = command(
        "docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"
    )
    if context not in {"default", "desktop-linux"} or not socket.startswith("unix:///"):
        raise ValueError("local Docker socket is required")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", database) or not re.search(
        r"(?:^|[_-])(?:test|ci|disposable)(?:$|[_-])", database, re.I
    ):
        raise ValueError("named disposable database is required")
    db = inspect(db_container, owner)
    provider = inspect(provider_container, owner)
    if not isolated(db):
        raise ValueError("database fixture is not network isolated")
    if provider["HostConfig"].get("ReadonlyRootfs") is not True or provider.get(
        "Mounts"
    ):
        raise ValueError("provider fixture source is mutable")
    tmpfs = provider["HostConfig"].get("Tmpfs") or {}
    if set(tmpfs) - {"/var/lib/postgresql/data"}:
        raise ValueError("provider fixture source can be overmounted")
    if not isolated(provider):
        raise ValueError("provider fixture is not network isolated")
    if (
        provider["Config"].get("Labels", {}).get("lyrashield.fixture-role")
        != "synthetic-provider"
    ):
        raise ValueError("provider fixture role is unavailable")

    db_port, db_relay_source = relay_port(
        db_container, relay_pid, port_file, allow_fault=True
    )
    provider_port, provider_relay_source = relay_port(
        provider_container, provider_relay_pid, provider_port_file
    )

    database_host = linux_identity(db_container, "postgres")
    provider_host = linux_identity(provider_container)
    if database_host["bootId"] != provider_host["bootId"]:
        raise ValueError("fixtures do not share the observed Linux boot")
    host = {
        "bootId": database_host["bootId"],
        "databaseTimeNamespace": database_host["timeNamespace"],
        "providerTimeNamespace": provider_host["timeNamespace"],
    }
    database_identity = command(
        "docker",
        "exec",
        "-u",
        "postgres",
        db_container,
        "psql",
        "-X",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        database,
        "-c",
        "SELECT system_identifier::text || ':' || d.oid::text FROM pg_control_system(), pg_database d WHERE d.datname=current_database()",
    )
    if not re.fullmatch(r"[1-9][0-9]{0,19}:[1-9][0-9]{0,9}", database_identity):
        raise ValueError("database incarnation is unavailable")
    if relay_database_identity(db_port, database) != database_identity:
        raise ValueError("relay and container database identities differ")

    source_sha = source_digest(PROVIDER_SOURCE)
    observed_sha = command(
        "docker", "exec", provider_container, "sha256sum", "/opt/fixture/provider.sh"
    ).split()[0]
    argv = command(
        "docker",
        "exec",
        provider_container,
        "sh",
        "-c",
        "tr '\\000' '\\n' </proc/1/cmdline",
    ).splitlines()
    executable = command(
        "docker", "exec", provider_container, "readlink", "/proc/1/exe"
    )
    stat = command("docker", "exec", provider_container, "cat", "/proc/1/stat")
    match = re.fullmatch(r"[0-9]+ \([^)]*\) (.+)", stat)
    start = (
        match.group(1).split()[19] if match and len(match.group(1).split()) > 19 else ""
    )
    if (
        observed_sha != source_sha
        or argv
        != [
            "/bin/busybox",
            "nc",
            "-lk",
            "-s",
            "127.0.0.1",
            "-p",
            "5432",
            "-e",
            "/opt/fixture/provider.sh",
        ]
        or executable != "/bin/busybox"
        or not start.isdecimal()
    ):
        raise ValueError("provider fixture process or source differs")
    endpoint = f"http://127.0.0.1:{provider_port}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(endpoint + "/fixture-identity", timeout=3) as response:
        if (
            response.status != 200
            or response.read(256) != b'{"fixture":"lyrashield-synthetic-provider/1"}'
        ):
            raise ValueError("synthetic provider response differs")

    if (
        fixture_snapshot(inspect(db_container, owner)) != fixture_snapshot(db)
        or fixture_snapshot(inspect(provider_container, owner))
        != fixture_snapshot(provider)
        or linux_identity(db_container, "postgres") != database_host
        or linux_identity(provider_container) != provider_host
        or relay_port(db_container, relay_pid, port_file, allow_fault=True)
        != (db_port, db_relay_source)
        or relay_port(provider_container, provider_relay_pid, provider_port_file)
        != (provider_port, provider_relay_source)
        or relay_database_identity(db_port, database) != database_identity
        or source_digest(PROVIDER_SOURCE) != source_sha
    ):
        raise ValueError("fixture changed during observation")

    host_digest = digest(host)
    db_details = {
        "containerId": db_container,
        "imageId": db["Image"],
        "systemIdentifier": database_identity.split(":")[0],
        "databaseOid": database_identity.split(":")[1],
        "database": database,
        "relayPid": relay_pid,
        "relayPort": int(db_port),
        "relaySourceSha256": db_relay_source,
    }
    provider_details = {
        "containerId": provider_container,
        "imageId": provider["Image"],
        "linuxPid": provider["State"]["Pid"],
        "processStartTicks": start,
        "executable": executable,
        "sourceSha256": source_sha,
        "relayPid": provider_relay_pid,
        "relaySourceSha256": provider_relay_source,
        "endpoint": endpoint,
    }
    db_identity = {
        key: db_details[key]
        for key in ("containerId", "imageId", "systemIdentifier", "databaseOid")
    }
    db_identity["hostIdentityDigest"] = host_digest
    return {
        "schema": "lyrashield-disposable-execution-context/1",
        "purpose": "disposable-execution-observation",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "context": {
            "environment": "DISPOSABLE",
            "databaseIncarnationId": digest(db_identity),
            "hostIdentityDigest": host_digest,
            "providerFixtureId": digest(provider_details),
        },
        "evidence": {
            "dockerContext": context,
            "owner": owner,
            "host": host,
            "database": db_details,
            "provider": provider_details,
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-container", required=True)
    parser.add_argument("--provider-container", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--relay-pid", required=True, type=int)
    parser.add_argument("--relay-port-file", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--provider-relay-pid", required=True, type=int)
    parser.add_argument("--provider-relay-port-file", required=True)
    args = parser.parse_args()
    result = observe(
        args.database_container,
        args.provider_container,
        args.owner,
        args.relay_pid,
        args.relay_port_file,
        args.database,
        args.provider_relay_pid,
        args.provider_relay_port_file,
    )
    print(canonical(result).decode())
