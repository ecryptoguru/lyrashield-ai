#!/usr/bin/python3
"""Launch finite native tests on an otherwise empty, network-isolated daemon.

The caller preloads genuine registry digests and mounts only the inner disposable
daemon's root directories. This entry point never creates production authority.
"""

import base64
import grp
import hashlib
import importlib.util
import json
import os
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

SOURCE = Path("/app")
CONFIG = Path("/etc/lyrashield")
CONTROL = Path("/opt/lyrashield/runtime-control")
STATE = Path("/var/lib/lyrashield/fixture")
CATALOG = CONFIG / "disposable-image-catalog.json"
ROLES = ("broker", "supervisor", "provider-gateway", "worker")
DEPENDENCIES = ("database", "redis", "provider")
IDS = {name: 10001 + number for number, name in enumerate(ROLES)}
PREFIX = "127.0.0.1:5000/lyrashield-fixture/"
ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/root",
    "TSX_DISABLE_CACHE": "1",
}


def require(value):
    if not value:
        raise RuntimeError("Owned disposable controller composition unavailable")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def checksum(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def run(args, *, env=None, input=None, timeout=30, maximum=1024 * 1024):
    result = subprocess.run(
        args,
        input=input,
        env=dict(ENV, **(env or {})),
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    require(result.returncode == 0 and len(result.stdout) <= maximum)
    return result.stdout


def docker(*args, **kwargs):
    return run(["/usr/bin/docker", *args], **kwargs)


def directory(path, mode=0o700, owner=0):
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=mode)
        os.chown(path, owner, owner)
    info = path.lstat()
    require(
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == owner
        and info.st_gid == owner
        and stat.S_IMODE(info.st_mode) == mode
    )


def write(path, raw, mode=0o400, group=0):
    descriptor = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode
    )
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(raw)
    os.chown(path, 0, group)
    path.chmod(mode)


def replace_policy(raw):
    temporary = CONFIG / ("policy-" + secrets.token_hex(16))
    write(temporary, raw)
    temporary.replace(CONFIG / "runtime-policy.json")


def module(name):
    path = CONTROL / (name + ".py")
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def load_catalog():
    require(os.geteuid() == 0 and sys.platform == "linux")
    info = CATALOG.lstat()
    require(
        stat.S_ISREG(info.st_mode)
        and info.st_uid == 0
        and info.st_nlink == 1
        and stat.S_IMODE(info.st_mode) == 0o400
        and info.st_size <= 16384
    )
    raw = CATALOG.read_bytes()
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
        }
    )
    require(value["schema"] == "lyrashield-disposable-image-catalog/1")
    require(re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*", value["owner"]))
    if len(sys.argv) == 3:
        require(value["owner"] == sys.argv[1] + ":" + sys.argv[2])
    else:
        require(len(sys.argv) == 1)
    require(
        all(
            re.fullmatch(r"[a-f0-9]{40}", value[name])
            for name in ("sourceRevision", "sourceTree", "engineRevision")
        )
    )
    require(set(value["images"]) == set(ROLES + DEPENDENCIES + ("sandbox", "host")))
    for role, reference in value["images"].items():
        require(
            re.fullmatch(re.escape(PREFIX + role) + r"@sha256:[a-f0-9]{64}", reference)
        )
    require(not Path("/sys/class/net/eth0").exists())
    require(
        not any(
            line.split()[1] == "00000000"
            for line in Path("/proc/net/route").read_text().splitlines()[1:]
        )
    )
    # Never attach to an existing host fleet: only this root control container may exist.
    rows = json.loads(docker("container", "inspect", os.environ.get("HOSTNAME", "")))
    require(len(rows) == 1 and rows[0]["HostConfig"]["ReadonlyRootfs"] is True)
    require(rows[0]["Config"]["Image"] == value["images"]["host"])
    require(
        set(docker("ps", "--all", "--quiet", "--no-trunc").decode().split())
        == {rows[0]["Id"]}
    )
    for role, reference in value["images"].items():
        images = json.loads(docker("image", "inspect", reference))
        require(len(images) == 1 and reference in images[0]["RepoDigests"])
        if role in ROLES or role == "host":
            labels = images[0]["Config"].get("Labels") or {}
            require(
                labels.get("org.opencontainers.image.revision")
                == value["sourceRevision"]
            )
            require(
                labels.get("org.opencontainers.image.source")
                == "https://github.com/ecryptoguru/lyrashield-ai"
            )
    for role, identity in IDS.items():
        group = grp.getgrnam("lyrashield-" + role)
        require(group.gr_gid == identity and not group.gr_mem)
    return value


class Composition:
    def __init__(self, catalog):
        self.catalog = catalog
        self.nonce = secrets.token_hex(32)
        self.epoch = "disposable-" + self.nonce[:32]
        self.network = "lyrashield-runtime-fixture-" + self.nonce[:16]
        self.names = {
            role: "lyrashield-fixture-" + role + "-" + self.nonce[:16]
            for role in DEPENDENCIES
        }
        self.containers = {}
        self.processes = []
        self.boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()

    def create(self, name, reference, arguments, env=None):
        values = env or {}
        args = [
            "create",
            "--pull=never",
            "--name",
            name,
            "--label",
            "lyrashield.disposable-owner=" + self.nonce,
            "--network",
            self.network,
            *arguments,
        ]
        for key in values:
            args += ["--env", key]
        identity = docker(*args, reference, env=values).decode().strip()
        require(re.fullmatch(r"[a-f0-9]{64}", identity))
        self.containers[identity] = reference
        docker("start", identity)
        return identity

    def remove(self, identity):
        row = json.loads(docker("container", "inspect", identity))[0]
        require(
            row["Id"] == identity
            and row["Config"]["Image"] == self.containers[identity]
            and row["Config"]["Labels"]["lyrashield.disposable-owner"] == self.nonce
        )
        docker("rm", "--force", "--volumes", identity)
        del self.containers[identity]

    def bootstrap(self):
        for path in (
            CONFIG / "control",
            STATE,
            Path("/var/lib/lyrashield/native-executor"),
            Path("/var/lib/lyrashield/controller"),
        ):
            directory(path)
        directory(CONTROL, 0o755)
        for name, relative in (
            (
                "paired-runtime-host-observation.py",
                ".github/scripts/paired-runtime-host-observation.py",
            ),
            *[
                (name + ".py", "ops/controller/" + name + ".py")
                for name in (
                    "authority-observer",
                    "native-executor",
                    "native-executor-tool",
                    "native-executor-pty",
                    "native-engine-result",
                    "source-tree",
                    "disposable-native-authority",
                    "disposable-observation",
                )
            ],
        ):
            write(CONTROL / name, (SOURCE / relative).read_bytes(), 0o555)
        ENV["TMPDIR"] = str(STATE)
        docker("network", "create", "--internal", self.network)
        admin = secrets.token_hex(24)
        self.database = self.create(
            self.names["database"],
            self.catalog["images"]["database"],
            ["--tmpfs", "/var/lib/postgresql/data:rw,nosuid,noexec,size=512m"],
            {"POSTGRES_PASSWORD": admin, "POSTGRES_DB": "lyrashield_test"},
        )
        self.redis = self.create(
            self.names["redis"],
            self.catalog["images"]["redis"],
            ["--tmpfs", "/data:rw,nosuid,noexec,size=64m"],
        )
        self.create(
            self.names["provider"],
            self.catalog["images"]["provider"],
            ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"],
        )
        end = time.monotonic() + 40
        while True:
            probe = subprocess.run(
                [
                    "/usr/bin/docker",
                    "exec",
                    self.database,
                    "pg_isready",
                    "-U",
                    "postgres",
                    "-d",
                    "lyrashield_test",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=ENV,
                check=False,
            )
            if probe.returncode == 0:
                break
            require(time.monotonic() < end)
            time.sleep(0.2)
        port_file = STATE / "database-port"
        relay = subprocess.Popen(
            [
                "/usr/bin/python3",
                str(SOURCE / "ops/prototypes/dispatch-plan-test/relay.py"),
                self.database,
                str(port_file),
                str(STATE / "stop-relay"),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=ENV,
        )
        self.processes.append(relay)
        end = time.monotonic() + 10
        while not port_file.exists():
            require(relay.poll() is None and time.monotonic() < end)
            time.sleep(0.05)
        port = port_file.read_text().strip()
        require(port.isdecimal())
        preparation = secrets.token_hex(24)
        environment = {
            "DATABASE_URL": f"postgresql://postgres:{admin}@127.0.0.1:{port}/lyrashield_test",
            "DISPATCH_PREPARATION_BROKER_DATABASE_URL": f"postgresql://dispatch_prepare_broker:{preparation}@127.0.0.1:{port}/lyrashield_test",
            "DISPATCH_PREPARATION_BROKER_PASSWORD": preparation,
            "LYRASHIELD_AUTHORITY_EPOCH_ID": self.epoch,
            "LYRASHIELD_TEST_DB_DISPOSABLE": "1",
            "BETTER_AUTH_SECRET": secrets.token_hex(32),
            "BETTER_AUTH_URL": "http://localhost:3000",
        }
        run(
            [
                "pnpm",
                "--filter",
                "@lyrashield/db",
                "exec",
                "prisma",
                "migrate",
                "deploy",
            ],
            env=environment,
            timeout=240,
        )
        raw = run(
            [
                "node",
                "--import",
                "tsx",
                str(SOURCE / "ops/controller/tests/disposable-bootstrap.ts"),
            ],
            env=environment,
            timeout=40,
        )
        self.credentials = json.loads(raw)
        for name in (
            "preparationUrl",
            "receiptUrl",
            "mirrorUrl",
            "readerUrl",
            "workerUrl",
            "stageUrl",
            "nativeUrl",
            "proofUrl",
        ):
            parsed = urlsplit(self.credentials[name])
            require(
                parsed.hostname == "127.0.0.1"
                and parsed.port == int(port)
                and parsed.path == "/lyrashield_test"
            )
            self.credentials[name] = urlunsplit(
                (
                    parsed.scheme,
                    parsed.username
                    + ":"
                    + parsed.password
                    + "@"
                    + self.names["database"]
                    + ":5432",
                    parsed.path,
                    "",
                    "",
                )
            )
        docker(
            "exec",
            self.redis,
            "redis-cli",
            "SET",
            "lyrashield:scan-admission:stopped",
            self.nonce,
        )

    def prepare_signer(self):
        # Provision only an ephemeral test signer; no authority exists before measurements.
        self.signing_key = CONFIG / "control/disposable-sandbox-grant-key.pem"
        run(
            [
                "openssl",
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:3072",
                "-out",
                str(self.signing_key),
            ]
        )
        self.signing_key.chmod(0o400)
        modulus = (
            run(["openssl", "rsa", "-in", str(self.signing_key), "-noout", "-modulus"])
            .decode()
            .strip()
            .split("=", 1)[1]
        )
        self.public_pin = {
            "purpose": "disposable-linux-native-tests",
            "algorithm": "RS256",
            "keyId": "disposable-" + self.nonce[:32],
            "publicKey": {
                "kty": "RSA",
                "n": base64.urlsafe_b64encode(bytes.fromhex(modulus))
                .decode()
                .rstrip("="),
                "e": "AQAB",
            },
        }
        module("paired-runtime-host-observation").public_der(self.public_pin)
        write(
            CONFIG / "disposable-native-pin.json", canonical(self.public_pin).encode()
        )
        # Keep this inode for the read-only bind. Empty bytes cannot authorize anything.
        write(CONFIG / "disposable-native-authority.json", b"")
        self.public_pem = run(
            ["openssl", "pkey", "-in", str(self.signing_key), "-pubout"]
        ).decode()

    def policy(self):
        self.prepare_signer()
        self.tokens = {
            name: secrets.token_hex(32)
            for name in (
                "broker",
                "supervisor",
                "provider",
                "provider-signing",
                "provider-encryption",
                "worker",
                "auth",
            )
        }
        credentials = self.credentials
        authority = canonical(credentials["journalAuthority"])
        instance = credentials["journalAuthority"]["supervisorInstanceId"]
        self.environments = {
            "broker": {
                "LYRASHIELD_BROKER_ADMISSION": "closed",
                "LYRASHIELD_BROKER_SOCKET_PATH": "/run/lyrashield/broker.sock",
                "LYRASHIELD_SCAN_EXECUTION_DATABASE_URL": credentials["preparationUrl"],
                "LYRASHIELD_SCAN_START_DATABASE_URL": credentials["stageUrl"],
                "LYRASHIELD_BROKER_CONTROL_TOKEN": self.tokens["broker"],
            },
            "supervisor": {
                "LYRASHIELD_RUNTIME_ADMISSION": "closed",
                "LYRASHIELD_SUPERVISOR_SOCKET_PATH": "/run/lyrashield/supervisor.sock",
                "LYRASHIELD_SCAN_EXECUTION_DATABASE_URL": credentials["nativeUrl"],
                "LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON": authority,
                "LYRASHIELD_SUPERVISOR_JOURNAL_PATH": "/var/lib/lyrashield/controller/supervisor/original.ndjson",
                "LYRASHIELD_SUPERVISOR_SIGNING_SECRET": credentials["originalSecret"],
                "LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET": credentials[
                    "wrapperSecret"
                ],
                "LYRASHIELD_SUPERVISOR_CONTROL_TOKEN": self.tokens["supervisor"],
                "LYRASHIELD_SUPERVISOR_INSTANCE_ID": instance,
                "LYRASHIELD_SANDBOX_GRANT_PUBLIC_KEY": self.public_pem,
                "LYRASHIELD_SANDBOX_GRANT_KEY_ID": self.public_pin["keyId"],
                "LYRASHIELD_SUPERVISOR_CGROUP_ROOT": "/sys/fs/cgroup",
                "LYRASHIELD_SUPERVISOR_ALLOWED_IMAGES": self.catalog["images"][
                    "sandbox"
                ],
                "LYRASHIELD_SUPERVISOR_ALLOWED_NETWORKS": self.network,
                "LYRASHIELD_PROVIDER_GATEWAY_URL": "https://" + self.names["provider"],
                "LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN": self.tokens["provider"],
            },
            "provider-gateway": {
                "LYRASHIELD_RUNTIME_ADMISSION": "closed",
                "LYRASHIELD_PROVIDER_GATEWAY_SOCKET_PATH": "/run/lyrashield/provider-gateway.sock",
                "LYRASHIELD_PROVIDER_GATEWAY_JOURNAL_PATH": "/var/lib/lyrashield/controller/provider-gateway/journal.ndjson",
                "LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN": self.tokens["provider"],
                "LYRASHIELD_PROVIDER_GATEWAY_SIGNING_SECRET": self.tokens[
                    "provider-signing"
                ],
                "LYRASHIELD_PROVIDER_GATEWAY_RESPONSE_ENCRYPTION_SECRET": self.tokens[
                    "provider-encryption"
                ],
                "LYRASHIELD_FIXTURE_PROVIDER_SECRET": "fixture-"
                + secrets.token_hex(32),
                "LYRASHIELD_PROVIDER_ROUTES_JSON": canonical(
                    [
                        {
                            "id": "fixture",
                            "baseUrl": "https://" + self.names["provider"],
                            "secretEnv": "LYRASHIELD_FIXTURE_PROVIDER_SECRET",
                            "authKind": "authorization",
                            "allowedPathPrefixes": ["/v1/"],
                        }
                    ]
                ),
            },
            "worker": {
                "DATABASE_URL": credentials["workerUrl"],
                "REDIS_URL": "redis://" + self.names["redis"] + ":6379/0",
                "BETTER_AUTH_SECRET": self.tokens["auth"],
                "BETTER_AUTH_URL": "http://localhost:3000",
                "NEXT_PUBLIC_APP_URL": "http://localhost:3000",
                "LYRASHIELD_WORKER_INSTANCE_CREDENTIAL": self.tokens["worker"],
                "LYRASHIELD_WORKER_IMAGE_DIGEST": self.catalog["images"][
                    "worker"
                ].split("@")[1],
                "LYRASHIELD_ENGINE_REVISION": self.catalog["engineRevision"],
            },
        }
        self.host_policy = {
            "schema": "lyrashield-runtime-host-policy/1",
            "network": self.network,
            "components": {},
            "journalSealControl": {"supervisorInstanceId": instance},
        }
        for role, values in self.environments.items():
            root = Path("/var/lib/lyrashield/controller") / role
            directory(root, owner=IDS[role])
            values["TMPDIR"] = str(root)
            nonsecret, files = {}, {}
            for name, value in values.items():
                if name.endswith(("TOKEN", "SECRET", "DATABASE_URL")) or name in (
                    "DATABASE_URL",
                    "REDIS_URL",
                    "LYRASHIELD_WORKER_INSTANCE_CREDENTIAL",
                ):
                    path = (
                        CONFIG
                        / "control"
                        / (
                            role
                            + "-"
                            + name.lower().replace("lyrashield_", "").replace("_", "-")
                            + ".value"
                        )
                    )
                    write(path, value.encode())
                    files[name] = str(path)
                else:
                    nonsecret[name] = value
            self.host_policy["components"][role] = {
                "uid": IDS[role],
                "gid": IDS[role],
                "environment": nonsecret,
                "credentialFiles": files,
                "processCommand": ["bootstrap-closed"],
            }
        self.context = {
            "schema": "lyrashield-disposable-native-context/1",
            "owner": self.catalog["owner"],
            "bootId": self.boot,
            "nonce": self.nonce,
            "sourceRevision": self.catalog["sourceRevision"],
            "sourceTree": self.catalog["sourceTree"],
        }
        write(
            CONFIG / "disposable-native-context.json", canonical(self.context).encode()
        )
        write(
            CONFIG / "control/disposable-scope.json",
            canonical(self.context).encode(),
            0o440,
            IDS["supervisor"],
        )

    def start_roles(self):
        raw = canonical(self.host_policy).encode()
        replace_policy(raw)
        policy_digest = checksum(raw)
        self.role_containers = {}
        for role in ROLES:
            root = str(Path("/var/lib/lyrashield/controller") / role)
            mounts = [
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--user",
                str(IDS[role]) + ":" + str(IDS[role]),
            ]
            for destination in (root, "/run/lyrashield", "/tmp"):
                mounts += [
                    "--mount",
                    "type=bind,source=" + root + ",destination=" + destination,
                ]
            mounts += [
                "--mount",
                "type=bind,source=/etc/lyrashield/runtime-policy.json,destination=/etc/lyrashield/runtime-policy.json,readonly",
            ]
            if role == "supervisor":
                mounts += [
                    "--mount",
                    "type=bind,source=/etc/lyrashield/control/disposable-scope.json,destination=/opt/lyrashield-runtime/disposable-native-context.json,readonly",
                ]
                for source, destination in (
                    (
                        "disposable-native-authority.json",
                        "disposable-native-authority.json",
                    ),
                    ("disposable-native-pin.json", "disposable-native-pin.json"),
                    (
                        "disposable-native-context.json",
                        "disposable-native-context.json",
                    ),
                    ("runtime-policy.json", "disposable-runtime-policy.json"),
                    (
                        "control/disposable-sandbox-grant-key.pem",
                        "disposable-sandbox-grant-key.pem",
                    ),
                ):
                    mounts += [
                        "--mount",
                        "type=bind,source=/etc/lyrashield/"
                        + source
                        + ",destination=/opt/lyrashield/control/"
                        + destination
                        + ",readonly",
                    ]
                for name, destination in (
                    ("authority.sock", "authority.sock"),
                    ("native-executor.sock", "native-executor.sock"),
                ):
                    mounts += [
                        "--mount",
                        "type=bind,source=/run/lyrashield/control/"
                        + name
                        + ",destination=/opt/lyrashield-runtime/"
                        + destination
                        + ",readonly",
                    ]
            values = dict(
                self.environments[role],
                LYRASHIELD_PRODUCT_REVISION=self.catalog["sourceRevision"],
                LYRASHIELD_AUTHORITY_EPOCH_ID=self.epoch,
                LYRASHIELD_RUNTIME_POLICY_DIGEST=policy_digest,
            )
            identity = self.create(
                "lyrashield-" + role, self.catalog["images"][role], mounts, values
            )
            self.role_containers[role] = identity
        end = time.monotonic() + 100
        while True:
            rows = [
                json.loads(docker("inspect", identity))[0]
                for identity in self.role_containers.values()
            ]
            require(all(row["State"]["Running"] is True for row in rows))
            if all(
                row["State"].get("Health", {}).get("Status") == "healthy"
                for row in rows
            ):
                break
            require(time.monotonic() < end)
            time.sleep(0.5)
        return rows

    def activated_service(self, path, group, helper, arguments=()):
        server = socket.socket(socket.AF_UNIX)
        server.bind(path)
        os.chown(path, 0, IDS[group])
        os.chmod(path, 0o660)
        server.listen(16)
        pid = os.fork()
        if pid == 0:
            os.dup2(server.fileno(), 3)
            os.set_inheritable(3, True)
            os.execve(
                "/usr/bin/python3",
                ["/usr/bin/python3", "-I", str(CONTROL / helper), *arguments],
                dict(ENV, LISTEN_PID=str(os.getpid()), LISTEN_FDS="1"),
            )
        server.close()
        self.processes.append(pid)

    def activate(self):
        self.activated_service(
            "/run/lyrashield/control/authority.sock",
            "supervisor",
            "authority-observer.py",
        )
        self.activated_service(
            "/run/lyrashield/control/broker-authority.sock",
            "broker",
            "authority-observer.py",
            ["--broker-read-only"],
        )
        self.activated_service(
            "/run/lyrashield/control/native-executor.sock",
            "supervisor",
            "native-executor.py",
        )

    def issue(self):
        observer = module("paired-runtime-host-observation")
        native = module("native-executor")
        policy_digest = checksum(canonical(self.host_policy).encode())
        values = dict(
            self.environments["supervisor"],
            LYRASHIELD_SCAN_EXECUTION_DATABASE_URL=self.credentials["readerUrl"],
            LYRASHIELD_PRODUCT_REVISION=self.catalog["sourceRevision"],
            LYRASHIELD_AUTHORITY_EPOCH_ID=self.epoch,
            LYRASHIELD_RUNTIME_POLICY_DIGEST=policy_digest,
            LYRASHIELD_PROVIDER_GATEWAY_URL="http://"
            + self.names["provider"]
            + ":8080",
        )
        write(
            CONFIG / "native-executor.env",
            (
                "\n".join(name + "=" + values[name] for name in native.ENV_NAMES) + "\n"
            ).encode(),
        )
        now = int(time.time())
        migrations = sorted(
            (SOURCE / "packages/db/prisma/migrations").glob("*/migration.sql")
        )
        migration_digest = checksum(
            canonical(
                [[path.parent.name, checksum(path.read_bytes())] for path in migrations]
            ).encode()
        )
        fields = {
            "productRevision": self.catalog["sourceRevision"],
            "engineRevision": self.catalog["engineRevision"],
            "migrationChecksum": migration_digest,
            "runtimePolicyDigest": policy_digest,
        }
        for role in ROLES + ("sandbox",):
            field = (
                "providerGatewayDigest"
                if role == "provider-gateway"
                else role + "Digest"
            )
            fields[field] = self.catalog["images"][role].split("@")[1]
        record = dict(
            fields,
            schema="lyrashield-disposable-native-authority/1",
            purpose="disposable-linux-native-tests",
            epochId=self.epoch,
            epoch=self.credentials["epoch"],
            owner=self.catalog["owner"],
            bootId=self.boot,
            nonce=self.nonce,
            sourceTree=self.catalog["sourceTree"],
            issuedAt=now,
            expiresAt=now + 900,
            dependencies={
                role: {"name": self.names[role], "image": self.catalog["images"][role]}
                for role in DEPENDENCIES
            },
        )
        # Check exact running roles before granting even this finite test purpose.
        observer.verify_controller_role_ids(
            self.host_policy["components"], IDS["supervisor"]
        )
        for role in ROLES:
            observer.component(
                role,
                self.host_policy,
                record,
                fixture_reference=self.catalog["images"][role],
            )
        raw = canonical(record)
        signature = run(
            ["openssl", "dgst", "-sha256", "-sign", str(self.signing_key)],
            input=raw.encode(),
        )
        envelope = {
            "raw": raw,
            "result": {
                "algorithm": "RS256",
                "keyId": self.public_pin["keyId"],
                "signature": base64.b64encode(signature).decode(),
            },
        }
        descriptor = os.open(
            CONFIG / "disposable-native-authority.json", os.O_WRONLY | os.O_NOFOLLOW
        )
        with os.fdopen(descriptor, "wb") as stream:
            info = os.fstat(stream.fileno())
            require(
                stat.S_ISREG(info.st_mode)
                and info.st_uid == 0
                and info.st_gid == 0
                and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o400
                and info.st_size == 0
            )
            stream.write(canonical(envelope).encode())
            stream.flush()
            os.fsync(stream.fileno())
        return record

    def close(self):
        for identity in list(self.containers):
            self.remove(identity)
        for process in self.processes:
            if isinstance(process, int):
                try:
                    os.kill(process, signal.SIGTERM)
                    os.waitpid(process, 0)
                except ProcessLookupError:
                    pass
            elif process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
        docker("network", "rm", self.network)


def main():
    composition = Composition(load_catalog())

    def stop(_signal, _frame):
        raise InterruptedError("Disposable job stopped")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        composition.bootstrap()
        composition.policy()
        composition.activate()
        rows = composition.start_roles()
        for role, row in zip(ROLES, rows, strict=True):
            command = (
                (Path("/proc") / str(row["State"]["Pid"]) / "cmdline")
                .read_bytes()
                .split(b"\0")[:-1]
            )
            composition.host_policy["components"][role]["processCommand"] = [
                value.decode() for value in command
            ]
        for identity in list(composition.role_containers.values()):
            composition.remove(identity)
        composition.start_roles()
        record = composition.issue()
        write(
            STATE / "liveness.json",
            canonical(
                {
                    "schema": "lyrashield-disposable-controller-liveness/1",
                    "owner": composition.catalog["owner"],
                    "sourceRevision": record["productRevision"],
                    "sourceTree": record["sourceTree"],
                    "purpose": record["purpose"],
                    "epochId": record["epochId"],
                    "bootId": record["bootId"],
                    "nonce": record["nonce"],
                    "expiresAt": record["expiresAt"],
                    "admission": "CLOSED",
                    "independentR2Journal": "UNQUALIFIED",
                    "nativeEffects": "UNMEASURED",
                }
            ).encode(),
        )
        print(
            "Owned disposable controller composition started; production qualification remains held.",
            flush=True,
        )
        while time.time() < record["expiresAt"]:
            time.sleep(0.5)
    finally:
        composition.close()


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
        print("Disposable controller composition failed closed.", file=sys.stderr)
        raise SystemExit(1) from None
