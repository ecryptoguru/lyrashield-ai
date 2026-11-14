#!/usr/bin/env python3
"""Run the bounded controller smoke on a new isolated Docker-in-Docker daemon."""

import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROLES = (
    "broker",
    "supervisor",
    "provider-gateway",
    "worker",
    "database",
    "redis",
    "provider",
    "sandbox",
    "host",
)
PREFIX = "127.0.0.1:5000/lyrashield-fixture/"
ENV = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}
DOCKER = shutil.which("docker")


def require(value):
    if not value:
        raise RuntimeError("Disposable candidate smoke unavailable")


def docker(*args, timeout=60):
    result = subprocess.run(
        [DOCKER, *args],
        env=ENV,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    require(result.returncode == 0)
    return result.stdout.strip()


def load_input(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        require(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == os.getuid()
            and info.st_nlink == 1
            and not info.st_mode & 0o077
            and info.st_size <= 16384
        )
        raw = os.read(descriptor, 16385)
        after = os.fstat(descriptor)
        require(
            len(raw) == info.st_size
            and (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            == (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        )
    finally:
        os.close(descriptor)
    value = json.loads(raw)
    require(
        set(value)
        == {
            "schema",
            "owner",
            "sourceRevision",
            "sourceTree",
            "engineRevision",
            "images",
            "infrastructure",
        }
    )
    require(value["schema"] == "lyrashield-disposable-candidate-input/1")
    require(re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*", value["owner"]))
    require(
        all(
            re.fullmatch(r"[a-f0-9]{40}", value[field])
            for field in ("sourceRevision", "sourceTree", "engineRevision")
        )
    )
    require(
        set(value["images"]) == set(ROLES)
        and set(value["infrastructure"]) == {"dind", "registry"}
    )
    for reference in [*value["images"].values(), *value["infrastructure"].values()]:
        require(re.fullmatch(r"(?:[a-z0-9._/:\-]+@)?sha256:[a-f0-9]{64}", reference))
    require(
        not any(
            os.environ.get(name)
            for name in (
                "DOCKER_HOST",
                "DOCKER_CONTEXT",
                "DOCKER_TLS_VERIFY",
                "DOCKER_CERT_PATH",
            )
        )
    )
    context = docker("context", "show")
    require(context in ("default", "desktop-linux"))
    require(
        docker(
            "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"
        ).startswith("unix:///")
    )
    for role in ("broker", "supervisor", "provider-gateway", "worker", "host"):
        image = json.loads(docker("image", "inspect", value["images"][role]))[0]
        labels = image["Config"].get("Labels") or {}
        require(
            labels.get("org.opencontainers.image.revision") == value["sourceRevision"]
        )
        require(
            labels.get("org.opencontainers.image.source")
            == "https://github.com/ecryptoguru/lyrashield-ai"
        )
    return value


def main():
    require(DOCKER and len(sys.argv) == 2)
    value = load_input(Path(sys.argv[1]).absolute())
    nonce = secrets.token_hex(24)
    image_ids = {
        role: json.loads(docker("image", "inspect", reference))[0]["Id"]
        for role, reference in value["images"].items()
    }
    infrastructure_ids = {
        role: json.loads(docker("image", "inspect", reference))[0]["Id"]
        for role, reference in value["infrastructure"].items()
    }
    outer = ""
    with tempfile.TemporaryDirectory(prefix="lyrashield-disposable-candidate-") as work:
        staging = Path(work)
        archive = staging / "images.tar"
        docker(
            "image",
            "save",
            "--output",
            str(archive),
            *dict.fromkeys([*image_ids.values(), infrastructure_ids["registry"]]),
            timeout=240,
        )
        try:
            outer = docker(
                "create",
                "--privileged",
                "--network",
                "none",
                "--label",
                "lyrashield.disposable-owner=" + nonce,
                value["infrastructure"]["dind"],
                "dockerd",
                "--host=unix:///var/run/docker.sock",
                "--insecure-registry=127.0.0.1:5000",
            )
            require(re.fullmatch(r"[a-f0-9]{64}", outer))
            docker("start", outer)
            end = time.monotonic() + 30
            while True:
                result = subprocess.run(
                    [DOCKER, "exec", outer, "docker", "info"],
                    env=ENV,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                )
                if result.returncode == 0:
                    break
                require(time.monotonic() < end)
                time.sleep(0.2)
            docker("cp", str(archive), outer + ":/tmp/images.tar", timeout=240)
            docker(
                "exec",
                outer,
                "docker",
                "image",
                "load",
                "--input",
                "/tmp/images.tar",
                timeout=240,
            )
            registry = docker(
                "exec",
                outer,
                "docker",
                "run",
                "--detach",
                "--network",
                "host",
                "--env",
                "REGISTRY_HTTP_ADDR=127.0.0.1:5000",
                infrastructure_ids["registry"],
            )
            references = {}
            try:
                for role, identity in image_ids.items():
                    tag = PREFIX + role + ":owned"
                    docker("exec", outer, "docker", "tag", identity, tag)
                    docker("exec", outer, "docker", "push", tag, timeout=180)
                    image = json.loads(
                        docker("exec", outer, "docker", "image", "inspect", tag)
                    )[0]
                    require(image["Id"] == identity)
                    candidates = [
                        reference
                        for reference in image["RepoDigests"]
                        if reference.startswith(PREFIX + role + "@sha256:")
                    ]
                    require(len(candidates) == 1)
                    references[role] = candidates[0]
            finally:
                docker("exec", outer, "docker", "rm", "--force", "--volumes", registry)
            catalog = {
                name: value[name]
                for name in ("owner", "sourceRevision", "sourceTree", "engineRevision")
            }
            catalog.update(
                schema="lyrashield-disposable-image-catalog/1", images=references
            )
            file = staging / "catalog.json"
            file.write_text(json.dumps(catalog, sort_keys=True, separators=(",", ":")))
            file.chmod(0o600)
            docker(
                "exec",
                outer,
                "mkdir",
                "-p",
                "/etc/lyrashield",
                "/opt/lyrashield/runtime-control",
                "/run/lyrashield/control",
                "/var/lib/lyrashield",
            )
            docker(
                "exec", outer, "chmod", "700", "/etc/lyrashield", "/var/lib/lyrashield"
            )
            docker(
                "exec",
                outer,
                "chmod",
                "755",
                "/opt/lyrashield/runtime-control",
                "/run/lyrashield/control",
            )
            docker(
                "cp",
                str(file),
                outer + ":/etc/lyrashield/disposable-image-catalog.json",
            )
            docker(
                "exec",
                outer,
                "chown",
                "0:0",
                "/etc/lyrashield/disposable-image-catalog.json",
            )
            docker(
                "exec",
                outer,
                "chmod",
                "400",
                "/etc/lyrashield/disposable-image-catalog.json",
            )
            arguments = [
                "exec",
                outer,
                "docker",
                "create",
                "--read-only",
                "--pid",
                "host",
                "--network",
                "host",
                "--user",
                "0:0",
                "--security-opt",
                "no-new-privileges",
            ]
            for path in (
                "/etc/lyrashield",
                "/opt/lyrashield/runtime-control",
                "/run/lyrashield/control",
                "/var/lib/lyrashield",
            ):
                arguments += [
                    "--mount",
                    "type=bind,source=" + path + ",destination=" + path,
                ]
            arguments += [
                "--mount",
                "type=bind,source=/var/run/docker.sock,destination=/var/run/docker.sock",
                references["host"],
            ]
            root_host = docker(*arguments)
            docker("exec", outer, "docker", "start", root_host)
            ready = "/var/lib/lyrashield/fixture/liveness.json"
            end = time.monotonic() + 420
            while True:
                probe = subprocess.run(
                    [DOCKER, "exec", outer, "test", "-f", ready],
                    env=ENV,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                )
                if probe.returncode == 0:
                    break
                state = json.loads(
                    docker("exec", outer, "docker", "inspect", root_host)
                )[0]["State"]
                require(state["Running"] is True and time.monotonic() < end)
                time.sleep(0.5)
            receipt = json.loads(docker("exec", outer, "cat", ready))
            require(
                receipt["purpose"] == "disposable-linux-native-tests"
                and receipt["admission"] == "CLOSED"
            )
            require(
                receipt["sourceRevision"] == value["sourceRevision"]
                and receipt["sourceTree"] == value["sourceTree"]
            )
            require(
                receipt["independentR2Journal"] == "UNQUALIFIED"
                and receipt["nativeEffects"] == "UNMEASURED"
            )
            descriptor = json.loads(
                docker(
                    "exec",
                    outer,
                    "docker",
                    "exec",
                    "--user",
                    "10002:10002",
                    "lyrashield-supervisor",
                    "node",
                    "--input-type=module",
                    "-e",
                    "import net from 'node:net';const c=net.createConnection('/opt/lyrashield-runtime/authority.sock');let out='';c.on('connect',()=>c.end('disposable-execution-authority'+String.fromCharCode(10)));c.on('data',b=>{out+=b;if(out.length>8192)process.exit(1)});c.on('end',()=>{if(!out)process.exit(1);process.stdout.write(out,()=>process.exit(0))});c.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),10000);",
                )
            )
            require(
                descriptor["purpose"] == "disposable-installed"
                and descriptor["owner"] == value["owner"]
                and descriptor["sourceRevision"] == value["sourceRevision"]
                and descriptor["nonce"] == receipt["nonce"]
            )
            # A real negative request has no original DB invocation guard and may
            # never create a ledger entry or physical object.
            action = {
                "phase": "EXECUTOR_CREATE",
                "operationId": "fixture-no-operation",
                "attemptId": "fixture-no-attempt",
                "scanId": "fixture-no-scan",
                "workspaceId": "fixture-no-workspace",
                "authorityEpochId": receipt["epochId"],
                "authorityRevision": 0,
                "authorityChecksum": "0" * 64,
                "actionChecksum": "0" * 64,
                "commandId": "fixture-no-command",
                "executorKey": "sandbox",
            }
            docker(
                "exec",
                outer,
                "docker",
                "exec",
                "--user",
                "10002:10002",
                "lyrashield-supervisor",
                "node",
                "--input-type=module",
                "-e",
                "import net from 'node:net';const action="
                + json.dumps(action)
                + ";const c=net.createConnection('/opt/lyrashield-runtime/native-executor.sock');let n=0;c.on('connect',()=>c.end(JSON.stringify({schema:1,method:'create',guardId:'fixture-no-database-guard',action})+String.fromCharCode(10)));c.on('data',b=>n+=b.length);c.on('end',()=>process.exit(n===0?0:1));c.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),10000);",
            )
            dependencies = json.loads(
                docker(
                    "exec",
                    outer,
                    "cat",
                    "/etc/lyrashield/disposable-native-authority.json",
                )
            )
            database = json.loads(dependencies["raw"])["dependencies"]["database"][
                "name"
            ]
            logs = subprocess.run(
                [DOCKER, "exec", outer, "docker", "logs", database],
                env=ENV,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            require(
                logs.returncode == 0
                and "read_scan_native_origin_guard" in logs.stdout + logs.stderr
            )
            require(
                docker(
                    "exec",
                    outer,
                    "find",
                    "/var/lib/lyrashield/native-executor",
                    "-name",
                    "*.json",
                )
                == ""
            )
            print(json.dumps(receipt, sort_keys=True))
            docker(
                "exec", outer, "docker", "stop", "--time", "20", root_host, timeout=30
            )
        finally:
            if outer:
                row = json.loads(docker("inspect", outer))[0]
                require(
                    row["Id"] == outer
                    and row["Image"] == infrastructure_ids["dind"]
                    and row["Config"]["Labels"]["lyrashield.disposable-owner"] == nonce
                    and row["HostConfig"]["NetworkMode"] == "none"
                    and row["HostConfig"]["Privileged"] is True
                )
                docker("rm", "--force", "--volumes", outer, timeout=60)


if __name__ == "__main__":
    try:
        main()
    except (
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
    ):
        print(
            "Disposable candidate smoke failed closed; no qualification was issued.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
