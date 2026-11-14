#!/usr/bin/env python3
"""Expose the fixed, read-only host authority observation over a private socket."""

import grp
import json
import os
import re
import socket
import stat
import struct
import subprocess
import sys
from pathlib import Path

SOCKET = Path("/run/lyrashield/control/authority.sock")
BROKER_SOCKET = Path("/run/lyrashield/control/broker-authority.sock")
WORKER_SOCKET = Path("/run/lyrashield/control/worker-authority.sock")
HELPER = Path("/opt/lyrashield/runtime-control/paired-runtime-host-observation.py")
PIN = Path("/opt/lyrashield/runtime-control/runtime-qualification-key.json")
REQUEST = b"execution-authority\n"
DISPOSABLE_REQUEST = b"disposable-execution-authority\n"
DISPOSABLE_HELPER = HELPER.with_name("disposable-observation.py")
WORKER_HELPER = HELPER.with_name("worker-observation.py")
WORKER_REQUEST = b"worker-execution-authority\n"


def protected(path, directory):
    info = path.lstat()
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid_type or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("Protected authority path unavailable")


def observe():
    for path in (Path("/opt"), Path("/opt/lyrashield"), HELPER.parent):
        protected(path, True)
    for path in (HELPER, PIN):
        protected(path, False)
    result = subprocess.run(
        ["/usr/bin/python3", str(HELPER), "execution-authority", str(PIN)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env={
            "PATH": "/usr/bin:/bin",
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        },
        timeout=6,
        check=True,
    )
    return result.stdout.rstrip(b"\n")


def connection_peer(conn):
    return struct.unpack(
        "3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    )


def observe_disposable(peer):
    for path in (Path("/opt"), Path("/opt/lyrashield"), HELPER.parent):
        protected(path, True)
    protected(DISPOSABLE_HELPER, False)
    result = subprocess.run(
        ["/usr/bin/python3", "-I", str(DISPOSABLE_HELPER), *map(str, peer)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
        timeout=6,
        check=True,
    )
    return result.stdout.rstrip(b"\n")


def observe_worker(peer, request=None):
    for path in (Path("/opt"), Path("/opt/lyrashield"), HELPER.parent):
        protected(path, True)
    protected(WORKER_HELPER, False)
    result = subprocess.run(
        ["/usr/bin/python3", "-I", str(WORKER_HELPER), *map(str, peer)],
        input=b""
        if request is None
        else json.dumps(request, separators=(",", ":")).encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
        timeout=6,
        check=True,
    )
    return result.stdout.rstrip(b"\n")


def handle_connection(conn, broker_read_only=False, worker_read_only=False):
    with conn:
        try:
            conn.settimeout(3)
            request = bytearray()
            maximum = 4096 if worker_read_only else len(DISPOSABLE_REQUEST)
            while len(request) <= maximum and not request.endswith(b"\n"):
                chunk = conn.recv(maximum + 1 - len(request))
                if not chunk:
                    return
                request.extend(chunk)
            if worker_read_only:
                if bytes(request) == WORKER_REQUEST:
                    response = observe_worker(connection_peer(conn))
                else:
                    if len(request) > maximum or not request.endswith(b"\n"):
                        return
                    parsed = json.loads(request)
                    method = parsed.get("method") if isinstance(parsed, dict) else None
                    keys = (
                        {"schema", "method", "operationId"}
                        if method == "result-proof"
                        else {"schema", "method"}
                        | (
                            {"cursor"}
                            if method in {"inventory", "cleanup-inventory"}
                            and "cursor" in parsed
                            else set()
                        )
                    )
                    if (
                        method not in {
                            "result-proof", "inventory", "cleanup-authority", "cleanup-inventory"
                        }
                        or set(parsed) != keys
                        or type(parsed["schema"]) is not int
                        or parsed["schema"] != 1
                    ):
                        return
                    for name in keys - {"schema", "method"}:
                        if (
                            not isinstance(parsed[name], str)
                            or not re.fullmatch(
                                r"[A-Za-z0-9][A-Za-z0-9._:-]{2,191}", parsed[name]
                            )
                            or ".." in parsed[name]
                        ):
                            return
                    response = observe_worker(connection_peer(conn), parsed)
            elif bytes(request) == REQUEST:
                response = observe()
            elif bytes(request) == DISPOSABLE_REQUEST and not broker_read_only:
                response = observe_disposable(connection_peer(conn))
            else:
                return
            if (
                not response
                or len(response) >= (32768 if worker_read_only else 8192)
                or b"\n" in response
            ):
                return
            conn.sendall(response + b"\n")
        except (
            OSError,
            RuntimeError,
            ValueError,
            TypeError,
            subprocess.SubprocessError,
        ):
            return


def activation_target(arguments):
    if arguments == []:
        return SOCKET, "lyrashield-supervisor"
    if arguments == ["--broker-read-only"]:
        return BROKER_SOCKET, "lyrashield-broker"
    if arguments == ["--worker-read-only"]:
        return WORKER_SOCKET, "lyrashield-worker"
    raise RuntimeError("Only fixed authority observation sockets are supported")


def main():
    socket_path, group = activation_target(sys.argv[1:])
    if os.geteuid() != 0 or os.environ.get("LISTEN_PID") != str(os.getpid()):
        raise RuntimeError("Root socket activation required")
    if os.environ.get("LISTEN_FDS") != "1":
        raise RuntimeError("One authority socket is required")
    for path in (Path("/run"), Path("/run/lyrashield"), socket_path.parent):
        protected(path, True)
    info = socket_path.lstat()
    if (
        not stat.S_ISSOCK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != grp.getgrnam(group).gr_gid
        or stat.S_IMODE(info.st_mode) != 0o660
    ):
        raise RuntimeError("Authority socket is not protected")
    with socket.socket(fileno=3) as server:
        if (
            server.family != socket.AF_UNIX
            or server.getsockname() != str(socket_path)
            or server.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1
        ):
            raise RuntimeError("Activated authority socket is invalid")
        while True:
            conn, _ = server.accept()
            handle_connection(
                conn,
                broker_read_only=group == "lyrashield-broker",
                worker_read_only=group == "lyrashield-worker",
            )


if __name__ == "__main__":
    main()
