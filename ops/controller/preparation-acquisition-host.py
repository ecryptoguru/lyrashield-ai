#!/usr/bin/python3
"""Fixed root host-network SDK launcher using a held qualified read-only image root."""
import ctypes
import fcntl
import os
from pathlib import Path
import stat
import sys


def require(value):
    if not value:
        raise RuntimeError("Root acquisition namespace unavailable")


def launch():
    require(os.geteuid() == 0 and os.uname().machine in ("x86_64", "aarch64") and len(sys.argv) == 5)
    require(all(value.isdecimal() for value in sys.argv[1:4]))
    image_fd, namespace_fd, resolver_fd = map(int, sys.argv[1:4])
    require(min(image_fd, namespace_fd, resolver_fd) >= 3 and len({image_fd, namespace_fd, resolver_fd}) == 3)
    image = os.fstat(image_fd)
    resolver = os.fstat(resolver_fd)
    require(stat.S_ISDIR(image.st_mode) and image.st_uid == 0 and not image.st_mode & 0o022)
    require(stat.S_ISREG(resolver.st_mode) and resolver.st_uid == 0 and stat.S_IMODE(resolver.st_mode) == 0o400 and 0 < resolver.st_size <= 8192)
    require(resolver.st_nlink == 1 and fcntl.ioctl(namespace_fd, 0xb703, 0) == 0x00020000)  # NS_GET_NSTYPE = mount
    root = Path(sys.argv[4])
    require(root.name == "image" and root.parent.parent == Path("/var/lib/lyrashield/preparation") and root.parent.name.startswith("acquisition-"))
    for path in [root.parent.parent, root.parent, root]:
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700)
    snapshot = root.parent / "resolver.snapshot"
    info = snapshot.lstat()
    require((info.st_dev, info.st_ino) == (resolver.st_dev, resolver.st_ino))
    require(not any(root.iterdir()))
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p]
    def mount(source, target, flags):
        if libc.mount(source.encode() if source else None, str(target).encode(), None, flags, None) != 0:
            raise OSError(ctypes.get_errno(), "Protected acquisition mount unavailable")
    # Linux >=5.2 open_tree/move_mount clone held exact inodes before leaving their namespace.
    # Namespace switches only select the image for a clone; no controller mount is modified.
    libc.syscall.restype = ctypes.c_long
    def clone(descriptor, recursive=False):
        flags = 1 | 0x1000 | os.O_CLOEXEC | (0x8000 if recursive else 0)
        cloned = libc.syscall(428, descriptor, ctypes.c_char_p(b""), flags)
        if cloned < 0:
            raise OSError(ctypes.get_errno(), "Protected acquisition image clone unavailable")
        return cloned
    def attach(descriptor, target):
        if libc.syscall(429, descriptor, ctypes.c_char_p(b""), -100, ctypes.c_char_p(str(target).encode()), 4) != 0:
            raise OSError(ctypes.get_errno(), "Protected acquisition image mount unavailable")
    host_namespace = os.open("/proc/self/ns/mnt", os.O_RDONLY)
    resolver_mount = clone(resolver_fd)
    require(libc.setns(namespace_fd, 0x00020000) == 0)
    image_mount = clone(image_fd, recursive=True)
    require(libc.setns(host_namespace, 0x00020000) == 0)
    os.close(host_namespace)
    require(libc.unshare(0x00020000) == 0)
    mount(None, "/", 16384 | 262144)  # MS_REC | MS_PRIVATE
    attach(image_mount, root)
    os.close(image_mount)
    mount(None, root, 4096 | 32 | 1 | 2 | 4)
    target = root / "etc/resolv.conf"
    require(target.is_file() and not target.is_symlink())
    attach(resolver_mount, target)
    os.close(resolver_mount)
    mount(None, target, 4096 | 32 | 1 | 2 | 4 | 8)  # remount bind read-only,nosuid,nodev,noexec
    os.chroot(root)
    os.chdir("/app")
    os.close(resolver_fd)
    os.close(namespace_fd)
    os.close(image_fd)
    # Namespace setup is finished. The SDK has no Linux capabilities or privilege regain.
    require(libc.prctl(38, 1, 0, 0, 0) == 0)  # PR_SET_NO_NEW_PRIVS
    require(libc.prctl(28, 15, 0, 0, 0) == 0)  # locked NOROOT + NO_SETUID_FIXUP
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]
    class Capabilities(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]
    header, capabilities = Header(0x20080522, 0), (Capabilities * 2)()
    require(libc.capset(ctypes.byref(header), ctypes.byref(capabilities)) == 0)
    os.execve("/usr/local/bin/node", ["node", "--max-old-space-size=128", "--max-semi-space-size=8", "--import", "tsx", "/app/src/preparation-acquire.mjs"],
              {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/nonexistent", "TSX_DISABLE_CACHE": "1"})


if __name__ == "__main__":
    try:
        launch()
    except Exception:
        sys.exit(1)
