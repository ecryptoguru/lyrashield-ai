"""Read hash-pinned drill fixtures through held directory descriptors, never through links."""

import argparse
import contextlib
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
PINS = {
    "writer": (
        "summary.json",
        21577,
        "9f35f1e046f8a2a23f29a13a2ea6900d5d81a299806a67d99511bd5f438f663b",
    ),
    "distinct": (
        "receipt.json",
        705,
        "737230a09793fb52fd6b1bedacef9ca4f48147a12c5e73bdcb40f872fbe1f4d4",
    ),
}
ALLOW_FILES = {"run.json", "http_exchanges.json", "vulnerabilities.json"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


@contextlib.contextmanager
def directory(path):
    path = Path(path).absolute()
    # macOS system /tmp is a documented alias. Every remaining component is no-follow.
    if sys.platform == "darwin" and path.parts[1:2] == ("tmp",):
        path = Path("/private/tmp", *path.parts[2:])
    fd = os.open("/", DIRECTORY)
    try:
        for part in path.parts[1:]:
            require(part not in ("", ".", ".."), "noncanonical directory")
            child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def members(fd, expected):
    found = set()
    with os.scandir(fd) as entries:
        for entry in entries:
            require(entry.name in expected, "unexpected fixture entry")
            found.add(entry.name)
    require(found == expected, "missing fixture entry")


def read_checked(fd, name, size, digest):
    require(
        0 < size <= 2 * 1024 * 1024 and "/" not in name,
        "unbounded fixture size or name",
    )
    before = os.stat(name, dir_fd=fd, follow_symlinks=False)
    require(
        stat.S_ISREG(before.st_mode)
        and before.st_nlink == 1
        and before.st_size == size,
        "linked, nonregular or wrong-size fixture file",
    )
    source = os.open(name, FILE, dir_fd=fd)
    try:
        opened = os.fstat(source)
        require(
            (opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino)
            and stat.S_ISREG(opened.st_mode)
            and opened.st_nlink == 1
            and opened.st_size == size,
            "fixture changed during open",
        )
        data = bytearray()
        while len(data) <= size:
            block = os.read(source, min(65536, size + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        require(
            len(data) == size and hashlib.sha256(data).hexdigest() == digest,
            "fixture bytes differ from receipt",
        )
        return bytes(data)
    finally:
        os.close(source)


def load(kind, root):
    receipt, size, digest = PINS[kind]
    with directory(root) as fd:
        raw = read_checked(fd, receipt, size, digest)
        parsed = json.loads(raw)
        rows = parsed if kind == "writer" else {"distinct-owners": parsed}
        require(len(rows) == (13 if kind == "writer" else 1), "wrong case count")
        if kind == "writer":
            members(fd, set(rows) | {receipt})
        verified = {receipt: raw}
        cases = []
        for name, row in rows.items():
            require(
                name.isascii() and name.replace("-", "").isalnum(), "invalid case name"
            )
            files = row["files"]
            require(set(files) <= ALLOW_FILES, "unexpected artifact name")
            sub = (
                os.open(name, DIRECTORY, dir_fd=fd) if kind == "writer" else os.dup(fd)
            )
            try:
                members(sub, set(files) | ({receipt} if kind == "distinct" else set()))
                payloads = {}
                for filename, expected in files.items():
                    data = read_checked(
                        sub, filename, expected["bytes"], expected["sha256"]
                    )
                    verified[(name + "/" if kind == "writer" else "") + filename] = data
                    payloads[filename] = data.decode("utf-8")
                run = json.loads(payloads["run.json"])
                require(
                    run["run_id"] == row["run_name"] == run["run_name"],
                    "wrong run identity",
                )
                cases.append(
                    {"name": name, "id": row["run_name"], "bytes": payloads, "row": row}
                )
            finally:
                os.close(sub)
        require(len(verified) == (38 if kind == "writer" else 4), "wrong file count")
        require(
            sum(map(len, verified.values()))
            == (1174288 + size if kind == "writer" else 6928 + size),
            "wrong total bytes",
        )
        return verified, cases


def stage(files, output):
    # The caller supplied a new child of its private mktemp directory. Stage only the
    # verified buffers; never reopen the original tree or preserve input permissions/links.
    with directory(output.parent) as parent:
        os.mkdir(output.name, 0o755, dir_fd=parent)
        fd = os.open(output.name, DIRECTORY, dir_fd=parent)
        try:
            dirs = {}
            try:
                for relative, data in files.items():
                    parts = relative.split("/")
                    if len(parts) == 2 and parts[0] not in dirs:
                        os.mkdir(parts[0], 0o755, dir_fd=fd)
                        dirs[parts[0]] = os.open(parts[0], DIRECTORY, dir_fd=fd)
                    dest = dirs[parts[0]] if len(parts) == 2 else fd
                    out = os.open(
                        parts[-1],
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                        0o644,
                        dir_fd=dest,
                    )
                    with os.fdopen(out, "wb") as stream:
                        stream.write(data)
                        os.fchmod(stream.fileno(), 0o644)
                    if dest != fd:
                        os.fchmod(dest, 0o755)
                os.fchmod(fd, 0o755)
            finally:
                for child in dirs.values():
                    os.close(child)
        finally:
            os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=PINS)
    parser.add_argument("root", type=Path)
    parser.add_argument("--stage", type=Path)
    args = parser.parse_args()
    verified, cases = load(args.kind, args.root)
    if args.stage:
        stage(verified, args.stage)
    else:
        json.dump(cases, sys.stdout, separators=(",", ":"))
