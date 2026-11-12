#!/usr/bin/python3
"""Verify the actual native barrier and the exact protected release's owner."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

STATE = Path('/var/lib/lyrashield/worker-cold-start')
IMAGE = re.compile(r'^ghcr\.io/ecryptoguru/(?:lyrashield-ai/lyrashield-worker|lyrashield-sandbox)(?::[^@\s]+)?@sha256:[a-f0-9]{64}$')


def canonical(image):
    if not isinstance(image, str) or not IMAGE.fullmatch(image):
        raise ValueError('Immutable cold image required')
    name, digest = image.split('@')
    return name.split(':')[0] + '@' + digest


def read_root_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > 65536:
            raise ValueError('Untrusted cold receipt')
        with os.fdopen(descriptor, 'rb') as stream:
            descriptor = None
            raw = stream.read()
            return json.loads(raw), hashlib.sha256(raw).hexdigest()
    finally:
        if descriptor is not None:
            os.close(descriptor)


def verify_barrier(state, boot_id, worker_image, sandbox_image, context, owner, image, product, engine, candidate_sandbox, stopped):
    directory = state.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o022:
        raise ValueError('Untrusted cold barrier directory')
    if (state / 'pending').exists() or (state / 'pending').is_symlink():
        raise ValueError('Cold barrier is pending')
    receipt, checksum = read_root_json(state / 'receipt.json')
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
    identity = context['identity']
    if context.get('barrierSha256') != checksum or identity.get('owner') != owner or identity.get('product') != product or identity.get('engine') != engine or canonical(identity.get('image')) != canonical(image) or canonical(identity.get('sandbox')) != canonical(candidate_sandbox) or canonical(context.get('oldWorker')) != canonical(worker_image) or canonical(context.get('oldSandbox')) != canonical(sandbox_image):
        raise ValueError('Barrier does not belong to this exact release')
    marker = state / 'owner-started'
    if marker.exists() or marker.is_symlink():
        started, _ = read_root_json(marker)
        if started.get('owner') != owner or started.get('receiptSha256') != checksum or started.get('bootId') != boot_id.strip() or canonical(started.get('workerImage')) != canonical(image) or started.get('productRevision') != product or started.get('engineRevision') != engine or not re.fullmatch('[a-f0-9]{64}', started.get('epochSha256', '')):
            raise ValueError('A different native owner started after the barrier')
    elif not stopped():
        raise ValueError('Legacy owner is not actually stopped')
    return receipt


def stopped_worker():
    def output(args):
        return subprocess.run(args, capture_output=True, text=True, timeout=30, check=True).stdout.strip()
    # A stopped systemd owner and empty exact native name are both required.
    return output(['systemctl', 'show', 'lyrashield-worker.service', '--property=ActiveState', '--value']) == 'inactive' and output(['systemctl', 'show', 'lyrashield-worker.service', '--property=MainPID', '--value']) == '0' and output(['docker', 'ps', '-a', '--filter', 'name=^/lyrashield-worker$', '--format', '{{.ID}}']) == ''


if __name__ == '__main__':
    try:
        if len(sys.argv) != 9 or sys.argv[1] != 'assert-barrier' or os.geteuid() != 0:
            raise ValueError('Root cold barrier assertion required')
        worker, sandbox, owner, image, product, engine, candidate_sandbox = sys.argv[2:]
        if not re.fullmatch(r'[1-9][0-9]{0,19}:[1-9][0-9]{0,9}', owner):
            raise ValueError('Invalid release owner')
        context, _ = read_root_json(Path('/var/lib/lyrashield/cold-release-' + owner + '/context.json'))
        verify_barrier(STATE, Path('/proc/sys/kernel/random/boot_id').read_text(), worker, sandbox, context, owner, image, product, engine, candidate_sandbox, stopped_worker)
        print('COLD_BARRIER_VERIFIED')
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('Cold barrier unavailable, replayed or mismatched', file=sys.stderr)
        sys.exit(1)
