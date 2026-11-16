"""Exact engine D/F digest over a held, immutable root-owned Linux source tree."""
import hashlib
import os
import stat

ATTRS = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")


def require(value):
    if not value:
        raise RuntimeError("Protected source integrity unavailable")


def unchanged(before, after):
    require(all(getattr(before, name) == getattr(after, name) for name in ATTRS))


def read_source_tree(root):
    digest = hashlib.sha256()
    initial = os.lstat(root)
    require(stat.S_ISDIR(initial.st_mode) and initial.st_uid == 0 and not initial.st_mode & 0o222)
    device = initial.st_dev
    total = count = 0
    files = []

    def visit(fd, relative, depth):
        nonlocal total, count
        before = os.fstat(fd)
        require(depth <= 64 and before.st_dev == device and before.st_uid == 0 and not before.st_mode & 0o222)
        directories, regular = [], []
        for name in sorted(os.listdir(fd)):
            encoded = name.encode("utf-8", "strict")
            require(encoded and name not in (".", "..") and "/" not in name and "\0" not in name)
            count += 1
            require(count <= 10000)
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            require(info.st_uid == 0 and info.st_dev == device and not info.st_mode & 0o222)
            path = f"{relative}/{name}" if relative else name
            if stat.S_ISDIR(info.st_mode):
                directories.append((name, path, info))
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                require(info.st_size <= 5 * 1024 * 1024)
                total += info.st_size
                require(total <= 20 * 1024 * 1024)
                regular.append((name, path, info))
        for _, path, _ in directories:
            raw_path = path.encode()
            digest.update(b"D" + len(raw_path).to_bytes(8, "big") + raw_path)
        for name, path, info in regular:
            raw_path = path.encode()
            digest.update(b"F" + len(raw_path).to_bytes(8, "big") + raw_path + info.st_size.to_bytes(8, "big"))
            child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                unchanged(info, os.fstat(child))
                remaining = info.st_size
                file_hash = hashlib.sha256()
                while remaining:
                    raw = os.read(child, min(remaining, 1024 * 1024))
                    require(raw)
                    remaining -= len(raw)
                    digest.update(raw)
                    file_hash.update(raw)
                require(os.read(child, 1) == b"")
                unchanged(info, os.fstat(child))
                files.append({"path": path, "bytes": info.st_size, "checksum": file_hash.hexdigest()})
            finally:
                os.close(child)
        for name, path, info in directories:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                unchanged(info, os.fstat(child))
                visit(child, path, depth + 1)
            finally:
                os.close(child)
        unchanged(before, os.fstat(fd))

    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        unchanged(initial, os.fstat(descriptor))
        visit(descriptor, "", 0)
        unchanged(initial, os.lstat(root))
    finally:
        os.close(descriptor)
    return {"stagedTreeDigest": digest.hexdigest(), "entries": files}
