"""Fixed, root-owned persistent stage records; invoked only by protected VM RPC."""

import base64
import json
import os
import re
import stat
import sys

ROOT = "/var/lib/lyrashield/paired-runtime-control"
OWNER = re.compile(r"[1-9][0-9]{0,19}:[1-9][0-9]{0,9}")
STAGE = re.compile(r"(?:[a-z][a-z-]{0,63}|acquisition-use-[a-f0-9]{64})")


def directory(path, create=False):
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        initial = os.fstat(fd)
        if initial.st_uid != 0 or initial.st_mode & 0o022:
            raise ValueError("unsafe stage root ancestor")
        for component in path.split("/")[1:]:
            if create:
                try:
                    os.mkdir(component, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError("unsafe stage parent")
        if os.fstat(fd).st_mode & 0o077:
            raise ValueError("stage directory is not private")
        return fd
    except BaseException:
        os.close(fd)
        raise


def execute(request):
    if os.getuid() != 0 or type(request) is not dict:
        raise ValueError("protected stage identity unavailable")
    operation = request.get("operation")
    if operation not in ("directory", "create-directory", "write", "assert"):
        raise ValueError("unknown stage operation")
    owner = request.get("owner")
    if type(owner) is not str or (owner != "" and not OWNER.fullmatch(owner)):
        raise ValueError("invalid stage owner")
    allowed = {"operation", "owner"}
    if operation in ("write", "assert"):
        allowed.update(("stage", "body"))
    if set(request) != allowed:
        raise ValueError("invalid stage shape")
    root = directory(ROOT, create=True)
    fd = root
    try:
        if operation == "create-directory":
            if not owner:
                raise ValueError("root cannot be recreated")
            os.mkdir(owner, 0o700, dir_fd=root)  # Exclusive, including same-owner retry.
            os.fsync(root)
        if owner:
            fd = os.open(owner, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o077:
                raise ValueError("invalid private owner directory")
        if operation in ("directory", "create-directory"):
            return True
        stage, body = request["stage"], request["body"]
        if type(stage) is not str or not STAGE.fullmatch(stage) or type(body) is not str:
            raise ValueError("invalid stage record")
        data = body.encode("utf-8")
        if not 0 < len(data) <= 4096:
            raise ValueError("stage record too large")
        parsed = json.loads(body)
        if type(parsed) is not dict or parsed.get("stage") != stage or type(parsed.get("version")) is not int or parsed.get("version") != 1:
            raise ValueError("invalid stage body")
        if owner and parsed.get("pair", {}).get("owner") != owner:
            raise ValueError("foreign stage body")
        if not owner and not stage.startswith("acquisition-use-"):
            raise ValueError("unscoped root stage")
        flags = os.O_NOFOLLOW | os.O_NONBLOCK
        flags |= os.O_WRONLY | os.O_CREAT | os.O_EXCL if operation == "write" else os.O_RDONLY
        record = os.open(stage, flags, 0o600, dir_fd=fd)
        try:
            info = os.fstat(record)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077:
                raise ValueError("unsafe stage file")
            if operation == "write":
                view = memoryview(data)
                while view:
                    written = os.write(record, view)
                    if written <= 0:
                        raise OSError("short stage write")
                    view = view[written:]
                os.fsync(record)
                os.fsync(fd)
            else:
                if info.st_size > 4096 or os.read(record, 4097) != data:
                    raise ValueError("stage record mismatch")
                # A positive exact-match inspection also reestablishes the
                # required barriers after an earlier ambiguous write ACK.
                os.fsync(record)
                os.fsync(fd)
        finally:
            os.close(record)
        return True
    finally:
        if fd != root:
            os.close(fd)
        os.close(root)


if __name__ == "__main__":
    try:
        raw = base64.b64decode(sys.argv[1], validate=True)
        if len(raw) > 16384:
            raise ValueError("stage RPC too large")
        execute(json.loads(raw))
        print("true")
    except Exception:
        # Paths, body, prior stage and cloud diagnostics never leave this helper.
        print("Protected stage storage unavailable", file=sys.stderr)
        sys.exit(1)
