#!/usr/bin/python3
"""Read actual root-owned cold barrier evidence; no caller qualification facts."""
import datetime
import json
import os
from pathlib import Path
import re
import stat
import sys

STATE = Path('/var/lib/lyrashield/worker-cold-start')
IMAGE = re.compile(r'^ghcr\.io/ecryptoguru/(?:lyrashield-ai/lyrashield-worker|lyrashield-sandbox)(?::[^@\s]+)?@sha256:[a-f0-9]{64}$')


def canonical(image):
    if not isinstance(image, str) or not IMAGE.fullmatch(image):
        raise ValueError('Immutable cold image required')
    name, digest = image.split('@')
    return name.split(':')[0] + '@' + digest


def verify_barrier(state, boot_id, worker_image, sandbox_image):
    directory = state.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o022:
        raise ValueError('Untrusted cold barrier directory')
    if (state / 'pending').exists() or (state / 'pending').is_symlink():
        raise ValueError('Cold barrier is pending')
    path = state / 'receipt.json'
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > 65536:
            raise ValueError('Untrusted cold barrier receipt')
        with os.fdopen(descriptor, encoding='utf-8') as stream:
            descriptor = None
            receipt = json.load(stream)
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if receipt.get('bootId') != boot_id.strip() or receipt.get('network') != 'lyrashield-sandbox':
        raise ValueError('Cold barrier boot/network mismatch')
    if canonical(receipt.get('workerImage')) != canonical(worker_image) or canonical(receipt.get('sandboxImage')) != canonical(sandbox_image):
        raise ValueError('Cold barrier old image mismatch')
    finished = datetime.datetime.fromisoformat(receipt['finishedAt'].replace('Z', '+00:00'))
    if finished.tzinfo is None or finished > datetime.datetime.now(datetime.timezone.utc):
        raise ValueError('Invalid cold barrier completion time')
    removed = receipt.get('removedIds')
    if not isinstance(removed, list) or len(removed) > 4096 or len(set(removed)) != len(removed) or any(not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value) for value in removed):
        raise ValueError('Invalid native cleanup inventory')
    return receipt


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4 or sys.argv[1] != 'assert-barrier' or os.geteuid() != 0:
            raise ValueError('Root cold barrier assertion required')
        verify_barrier(STATE, Path('/proc/sys/kernel/random/boot_id').read_text(), sys.argv[2], sys.argv[3])
        print('COLD_BARRIER_VERIFIED')
    except (OSError, ValueError, KeyError, TypeError):
        print('Cold barrier unavailable or mismatched', file=sys.stderr)
        sys.exit(1)
