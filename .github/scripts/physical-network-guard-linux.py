#!/usr/bin/env python3
"""Exec a command under an inherited Linux seccomp policy denying outbound sockets.

Allows AF_UNIX socketpair use by asyncio, while denying connect, named datagram
sends, sendmsg/sendmmsg and io_uring. The caller must independently run the
network canary before using this guard.
"""
import ctypes
import errno
import os
import platform
import sys


class Filter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte),
                ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]


class Program(ctypes.Structure):
    _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]


def main():
    if len(sys.argv) < 2:
        raise SystemExit('expected command')
    machine = platform.machine().lower()
    tables = {
        'x86_64': (0xc000003e, 41, 42, 44, 46, 307),
        'aarch64': (0xc00000b7, 198, 203, 206, 211, 269),
        'arm64': (0xc00000b7, 198, 203, 206, 211, 269),
    }
    if machine not in tables:
        raise SystemExit('unsupported seccomp architecture')
    arch, socket_nr, connect_nr, sendto_nr, sendmsg_nr, sendmmsg_nr = tables[machine]
    load, jeq, jset, ret = 0x20, 0x15, 0x45, 0x06
    allow, deny = 0x7fff0000, 0x00050000 | errno.EPERM
    instructions = [
        (load,0,0,4),               # seccomp_data.arch
        (jeq,1,0,arch),
        (ret,0,0,deny),
        (load,0,0,0),               # seccomp_data.nr
    ]
    if machine == 'x86_64':
        instructions.extend([(jset,0,1,0x40000000),(ret,0,0,deny)])  # reject x32 ABI
    for number in (connect_nr, sendmsg_nr, sendmmsg_nr, 425, 426, 427):
        instructions.extend([(jeq,0,1,number),(ret,0,0,deny)])
    instructions.extend([
        (jeq,0,4,socket_nr),
        (load,0,0,16),              # socket domain, low 32 bits
        (jeq,0,1,1),                # AF_UNIX only
        (ret,0,0,allow),
        (ret,0,0,deny),
        (jeq,0,6,sendto_nr),
        (load,0,0,52),              # sendto address argument, high half
        (jeq,0,3,0),
        (load,0,0,48),              # address, low half
        (jeq,0,1,0),
        (ret,0,0,allow),           # connected socketpair's send()
        (ret,0,0,deny),            # named datagram send
        (ret,0,0,allow),
    ])
    data = (Filter * len(instructions))(*(Filter(*row) for row in instructions))
    program = Program(len(instructions), data)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), 'could not set no-new-privileges')
    if libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:  # PR_SET_SECCOMP, FILTER
        raise OSError(ctypes.get_errno(), 'could not install network seccomp filter')
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == '__main__':
    main()
