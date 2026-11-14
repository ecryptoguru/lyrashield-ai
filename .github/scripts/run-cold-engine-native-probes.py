#!/usr/bin/env python3
"""Run fixed installed-engine TCP/SIGKILL probes in an immutable Linux worker image."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import tomllib
from uuid import uuid4

ENGINE = "0793bcb9644a1985165963375586124c993c020a"
FILES = ("run-cold-engine-native-probes.py", "cold-engine-native-probe.py",
         "run-engine-physical-ceiling-drill.py", "cold-sandbox-native-probe.py")
SANDBOX_CASES = ("sandbox-provider-credentials-and-socket-absent",
                 "sandbox-live-sibling-and-outside-provider-tcp-denied")
CASES = tuple(f"{route}-{stream}-503-cap-no-retry"
              for route in ("responses", "chat", "litellm") for stream in ("plain", "stream")) + (
    "engine-budget-denies-before-tcp-dispatch", "engine-lost-ack-no-paid-resume",
    "engine-sigkill-no-paid-resume")


def invoke(command, **kwargs):
    result = subprocess.run(command, capture_output=True, timeout=120, **kwargs)
    if result.returncode:
        # Do not expose subprocess streams: operational environments may hold credentials.
        raise RuntimeError(f"{Path(command[0]).name} exited {result.returncode}")
    return result.stdout


def validate_cases(cases):
    if not isinstance(cases, list) or tuple(case.get("name") for case in cases) != CASES:
        raise RuntimeError("native case set failed or incomplete")
    for case in cases:
        if type(case.get("exitCode")) is not int or case["exitCode"] != 0:
            raise RuntimeError("native case failed")
        if case["name"].endswith("503-cap-no-retry"):
            if case.get("physicalRequests") != 1 or case.get("outputCap") != 128 or case.get("retainedPendingCharge") is not True:
                raise RuntimeError("physical request cap/retry proof failed")
        elif case["name"] == "engine-budget-denies-before-tcp-dispatch":
            held = case.get("heldReservationsUsd")
            if (case.get("configuredCapUsd") != 0.002 or case.get("deniedRequests") != 1
                    or not isinstance(held, (int, float)) or not 0 < held <= 0.002
                    or not isinstance(case.get("physicalRequests"), int) or case["physicalRequests"] < 1):
                raise RuntimeError("finite admission proof failed")
        elif (case.get("physicalRequests") != 1 or case.get("retainedPendingCharge") is not True
              or type(case.get("retryExitCode")) is not int or case["retryExitCode"] <= 0):
            raise RuntimeError("fresh interpreter replay proof failed")


def validate_sandbox_cases(cases):
    if not isinstance(cases, list) or tuple(case.get("name") for case in cases) != SANDBOX_CASES:
        raise RuntimeError("native sandbox cases incomplete")
    for case in cases:
        if type(case.get("exitCode")) is not int or case["exitCode"] != 0:
            raise RuntimeError("native sandbox case failed")
    isolation, network = cases
    if isolation.get("sandboxCount") != 2 or not all(isolation.get(key) is True for key in (
        "nonRoot", "configEnv", "environment", "procEnvironment", "privateFileAbsent", "hostMountsAbsent")):
        raise RuntimeError("native credential isolation proof failed")
    if network.get("directions") != 2 or not all(network.get(key) is True for key in (
        "siblingPositiveLoopbackCanary", "outsideProviderPositiveCanary", "internalBridge", "iccDisabled")):
        raise RuntimeError("native network isolation proof failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", nargs=2, required=True, metavar=("WORKER_IMAGE", "PRODUCT_SHA"))
    parser.add_argument("--engine-repo", required=True)
    parser.add_argument("--harness-sha", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--sandbox-image", help="Also probe native sandbox isolation; requires local Docker socket")
    parser.add_argument("--docker-socket", default="/var/run/docker.sock")
    args = parser.parse_args()
    image, product = args.candidate
    out = Path(args.receipt).absolute()
    if out.exists() or out.is_symlink():
        raise RuntimeError("receipt already exists")
    root = Path(__file__).resolve().parents[2]
    paths = [".github/scripts/" + name for name in FILES]
    proof = {"schema": "lyrashield.cold-engine-native.v1", "passed": False,
             "candidate": {"workerImage": image, "productRevision": product, "engineRevision": ENGINE},
             "harnessRevision": args.harness_sha, "cases": [],
             "unverified": ["actual-worker-db-redis-crash-claim-slot", "actual-sandbox-credential-egress",
                            "database-rollback-replay-barrier", "live-provider-billing", "image-provenance"],
             "limitations": ["Real Linux TCP to controlled fake provider; no paid provider traffic.",
                             "Engine process crash does not establish worker DB/Redis claim retention.",
                             "Unsigned receipt requires independent producer/artifact authentication."]}
    if args.sandbox_image:
        proof["schema"] = "lyrashield.cold-sandbox-native.v1"
        proof["candidate"]["sandboxImage"] = args.sandbox_image
        proof["unverified"].remove("actual-sandbox-credential-egress")
        proof["unverified"].append("target-relay-authenticated-grant-policy")
    created = None
    try:
        if not re.fullmatch(r"ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:[a-f0-9]{64}", image):
            raise RuntimeError("canonical immutable worker reference required")
        if not all(re.fullmatch(r"[a-f0-9]{40}", sha) for sha in (product, args.harness_sha)):
            raise RuntimeError("exact source commits required")
        hashes = {}
        for relative in paths:
            data = (root / relative).read_bytes()
            committed = invoke(["git", "-C", str(root), "show", args.harness_sha + ":" + relative])
            if data != committed:
                raise RuntimeError("harness differs from its committed source")
            hashes[relative] = hashlib.sha256(data).hexdigest()
        proof["harnessFiles"] = hashes
        proof["harnessSha256"] = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
        meta = json.loads(invoke(["docker", "image", "inspect", image]))[0]
        labels = meta.get("Config", {}).get("Labels") or {}
        if image not in (meta.get("RepoDigests") or []) or meta["Os"] != "linux":
            raise RuntimeError("local immutable Linux image required; runner never pulls")
        if labels.get("org.opencontainers.image.revision") != product or labels.get("io.lyrashield.engine.revision") != ENGINE:
            raise RuntimeError("worker source/engine labels mismatch")
        proof["imageId"] = meta["Id"]
        proof["architecture"] = meta["Architecture"]
        sandbox_meta = None
        if args.sandbox_image:
            if not re.fullmatch(r"ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:[a-f0-9]{64}", args.sandbox_image):
                raise RuntimeError("canonical immutable sandbox index required")
            sandbox_meta = json.loads(invoke(["docker", "image", "inspect", args.sandbox_image]))[0]
            if args.sandbox_image not in (sandbox_meta.get("RepoDigests") or []) or sandbox_meta["Os"] != "linux" or sandbox_meta["Architecture"] != meta["Architecture"]:
                raise RuntimeError("local immutable native sandbox required")
            socket_path = Path(args.docker_socket).resolve()
            if not stat.S_ISSOCK(socket_path.stat().st_mode):
                raise RuntimeError("native isolation requires the explicitly selected local Docker socket")
            proof["sandboxImageId"] = sandbox_meta["Id"]
        # Reuse reviewed exact-Git materialization and ownership-safe Docker cleanup.
        spec = importlib.util.spec_from_file_location("physical", root / paths[2])
        physical = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(physical)
        with tempfile.TemporaryDirectory(prefix="cold-native-") as temporary:
            source = Path(temporary) / "engine"
            physical._materialize_commit(Path(args.engine_repo).resolve(), source, ENGINE)
            engine_files = {path.relative_to(source).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                            for directory in ("lyrashield", "lyrashield_adapter", "strix")
                            for path in (source / directory).rglob("*.py") if path.is_file()}
            versions = {entry["name"]: entry["version"] for entry in tomllib.loads((source / "uv.lock").read_text())["package"]
                        if entry["name"] in ("openai", "openai-agents", "litellm", "httpx")}
            if len(versions) != 4 or not engine_files:
                raise RuntimeError("engine fingerprint incomplete")
            expected = {"engineFiles": engine_files, "versions": versions}
            if sandbox_meta:
                expected.update(workerImage=image, workerImageId=meta["Id"],
                    sandboxImage=args.sandbox_image, sandboxImageId=sandbox_meta["Id"])
            proof["engineFilesSha256"] = hashlib.sha256(json.dumps(engine_files, sort_keys=True).encode()).hexdigest()
            proof["versions"] = versions
            owner = uuid4().hex
            name = "cold-native-" + owner
            create = ["docker", "create", "-i", "--pull", "never", "--name", name,
                              "--label", "lyrashield.physical-drill-owner=" + owner, "--network", "bridge" if sandbox_meta else "none",
                              "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
                              "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                              "--memory", "2g", "--pids-limit", "256", "--cpus", "2",
                              "--entrypoint", "/opt/lyrashield-venv/bin/python"]
            if sandbox_meta:
                create += ["--mount", f"type=bind,src={socket_path},dst=/var/run/docker.sock",
                           "--env", "DOCKER_HOST=unix:///var/run/docker.sock", "--user", "0:0"]
            create += [image, "-I", "-"]
            created = invoke(create).decode().strip()
            if not re.fullmatch(r"[a-f0-9]{64}", created):
                created = None
                raise RuntimeError("container create ACK unknown; reconcile before retry")
            data = ("expected=" + repr(expected) + "\n").encode() + (root / paths[3 if sandbox_meta else 1]).read_bytes()
            try:
                result = subprocess.run(["docker", "start", "-a", "-i", created], input=data,
                                        capture_output=True, timeout=300)
                proof["exitCode"] = result.returncode
                proof["transcriptSha256"] = hashlib.sha256(result.stdout + b"\n" + result.stderr).hexdigest()
                marker = b"COLD_NATIVE_RESULT="
                records = [line[len(marker):] for line in result.stdout.splitlines() if line.startswith(marker)]
                if result.returncode or len(records) != 1:
                    raise RuntimeError("native probe failed; transcript retained only as checksum")
                observations = json.loads(records[0])
                cases = observations["cases"]
                if sandbox_meta:
                    validate_sandbox_cases(cases)
                    if observations.get("cleanupVerified") is not True:
                        raise RuntimeError("sandbox native cleanup unconfirmed")
                    proof["resources"] = {key: observations[key] for key in (
                        "sandboxContainerIds", "networkId", "outsideProviderContainerId")}
                else:
                    validate_cases(cases)
                proof["cases"] = cases
            finally:
                physical.cleanup_probe(name, owner, meta["Id"], created)
                created = None
            proof["cleanupVerified"] = True
            proof["passed"] = True
    except Exception as error:
        proof["error"] = str(error)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("x") as stream:
        json.dump(proof, stream, sort_keys=True)
        stream.write("\n")
    print(json.dumps({"passed": proof["passed"], "receipt": str(out)}))
    if not proof["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
