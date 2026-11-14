#!/usr/bin/env python3
"""Expose the fixed, read-only host authority observation over a private socket."""

import grp
import os
import socket
import stat
import subprocess
from pathlib import Path

SOCKET = Path("/run/lyrashield/control/authority.sock")
HELPER = Path("/opt/lyrashield/runtime-control/paired-runtime-host-observation.py")
PIN = Path("/opt/lyrashield/runtime-control/runtime-qualification-key.json")
REQUEST = b"execution-authority\n"


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
        env={"PATH": "/usr/bin:/bin", "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        timeout=6,
        check=True,
    )
    return result.stdout.rstrip(b"\n")


def handle_connection(conn):
    with conn:
        try:
            conn.settimeout(3)
            request = bytearray()
            while len(request) <= len(REQUEST) and not request.endswith(b"\n"):
                chunk = conn.recv(len(REQUEST) + 1 - len(request))
                if not chunk:
                    return
                request.extend(chunk)
            if bytes(request) != REQUEST:
                return
            response = observe()
            if not response or len(response) >= 8192 or b"\n" in response:
                return
            conn.sendall(response + b"\n")
        except (OSError, RuntimeError, subprocess.SubprocessError):
            return


def main():
    if os.geteuid() != 0 or os.environ.get("LISTEN_PID") != str(os.getpid()):
        raise RuntimeError("Root socket activation required")
    if os.environ.get("LISTEN_FDS") != "1":
        raise RuntimeError("One authority socket is required")
    for path in (Path("/run"), Path("/run/lyrashield"), SOCKET.parent):
        protected(path, True)
    info = SOCKET.lstat()
    if (
        not stat.S_ISSOCK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != grp.getgrnam("lyrashield-supervisor").gr_gid
        or stat.S_IMODE(info.st_mode) != 0o660
    ):
        raise RuntimeError("Authority socket is not protected")
    with socket.socket(fileno=3) as server:
        if (
            server.family != socket.AF_UNIX
            or server.getsockname() != str(SOCKET)
            or server.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1
        ):
            raise RuntimeError("Activated authority socket is invalid")
        while True:
            conn, _ = server.accept()
            handle_connection(conn)


if __name__ == "__main__":
    main()
