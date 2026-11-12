#!/usr/bin/env python3
"""Explicit native cold-host maintenance; never changes durable scan state."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

STATE = Path('/var/lib/lyrashield/worker-cold-start')
SERVICE = 'lyrashield-worker.service'
HEX_ID = re.compile(r'^sha256:[a-f0-9]{64}$')
RUN_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
SOURCE = 'org.opencontainers.image.revision'
ENGINE = 'io.lyrashield.engine.revision'


def command(program, arguments):
    result = subprocess.run([program, *arguments], check=True, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if len(result.stdout) > 1024 * 1024:
        raise RuntimeError('Native response exceeded bound')
    return result.stdout


@contextmanager
def locked(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def image_identity(reference, invoke):
    records = json.loads(invoke('docker', ['image', 'inspect', reference]))
    if len(records) != 1 or not HEX_ID.fullmatch(records[0].get('Id', '')):
        raise RuntimeError('Pinned old native image identity is unavailable')
    return records[0]


def stopped(record):
    state = record.get('State', {})
    return (state.get('Running') is False and state.get('Pid') == 0
            and not state.get('Restarting') and not state.get('Paused')
            and record.get('HostConfig', {}).get('RestartPolicy', {}).get('Name') in ('', 'no'))


def foreign_identity(record):
    return {key: record.get(key) for key in ('Id', 'Image', 'Name', 'Created', 'Mounts')}


def classify(records, options):
    owned, foreign = [], {}
    for record in records:
        if not re.fullmatch(r'[a-f0-9]{64}', record.get('Id', '')):
            raise RuntimeError('Invalid native container identity')
        labels = record.get('Config', {}).get('Labels') or {}
        host = record.get('HostConfig', {})
        if record.get('Name') == '/lyrashield-worker':
            if (record.get('Image') != options['workerImageId']
                    or any(labels.get(key) != options['workerLabels'][key] for key in (SOURCE, ENGINE))
                    or host.get('RestartPolicy', {}).get('Name') not in ('', 'no')):
                raise RuntimeError('Old worker identity mismatch')
            owned.append((record, True))
        elif 'strix-run-id' in labels:
            scan = labels['strix-run-id']
            binds = [mount for mount in record.get('Mounts', []) if mount.get('Type') == 'bind']
            if (record.get('Image') != options['sandboxImageId']
                    or not isinstance(scan, str) or not RUN_ID.fullmatch(scan) or '..' in scan
                    or host.get('NetworkMode') != options['network'] or not binds
                    or host.get('RestartPolicy', {}).get('Name') not in ('', 'no')
                    or any(not mount.get('Source', '').startswith('/var/lib/lyrashield/worker/')
                           or os.path.normpath(mount['Source']) != mount['Source'] for mount in binds)):
                raise RuntimeError('Unauthenticated native sandbox ownership')
            owned.append((record, False))
        elif stopped(record):
            foreign[record['Id']] = foreign_identity(record)
        else:
            raise RuntimeError('Foreign active or restartable container on cold host')
    return owned, foreign


def execute_barrier(options, invoke=command, owner_lock=None, complete=lambda result: result):
    worker = image_identity(options['workerImage'], invoke)
    sandbox = image_identity(options['sandboxImage'], invoke)
    labels = worker.get('Config', {}).get('Labels') or {}
    if any(not re.fullmatch(r'[a-f0-9]{40}', labels.get(key, '')) for key in (SOURCE, ENGINE)):
        raise RuntimeError('Pinned worker provenance is unavailable')
    trusted = {**options, 'workerImageId': worker['Id'], 'sandboxImageId': sandbox['Id'],
               'workerLabels': {key: labels[key] for key in (SOURCE, ENGINE)}}

    def inventory():
        ids = invoke('docker', ['container', 'ls', '--all', '--quiet', '--no-trunc']).split()
        return json.loads(invoke('docker', ['container', 'inspect', *ids])) if ids else []

    old, preserved = classify(inventory(), trusted)
    invoke('systemctl', ['stop', SERVICE])
    for prop, expected in (('ActiveState', 'inactive'), ('MainPID', '0')):
        if invoke('systemctl', ['show', SERVICE, f'--property={prop}', '--value']).strip() != expected:
            raise RuntimeError('Previous systemd owner did not terminate')
    # Production holds the same flock as the launcher throughout native cleanup.
    owner_context = owner_lock() if owner_lock else locked(STATE / 'owner.lock')
    with owner_context:
        _, before_daemon = classify(inventory(), trusted)
        if before_daemon != preserved:
            raise RuntimeError('Preserved stopped-container identity changed')
        invoke('systemctl', ['stop', 'docker.socket', 'docker.service'])
        for unit in ('docker.socket', 'docker.service'):
            for prop, expected in (('ActiveState', 'inactive'), ('MainPID', '0')):
                if invoke('systemctl', ['show', unit, f'--property={prop}', '--value']).strip() != expected:
                    raise RuntimeError('Native Docker owner did not terminate')
        invoke('systemctl', ['start', 'docker.service'])
        after, remaining_foreign = classify(inventory(), trusted)
        if remaining_foreign != preserved:
            raise RuntimeError('Preserved stopped-container identity changed')
        for record, owner in after:
            current_owned, current_foreign = classify(inventory(), trusted)
            current = next((entry for entry, _ in current_owned if entry['Id'] == record['Id']), None)
            if current is None or current_foreign != preserved:
                raise RuntimeError('Native cleanup identity changed')
            if owner and not stopped(current):
                raise RuntimeError('Previous native worker survived cold barrier')
            invoke('docker', ['container', 'rm', '--force', record['Id']])
        owned, final_foreign = classify(inventory(), trusted)
        if owned or final_foreign != preserved:
            raise RuntimeError('Native cleanup acknowledgement is incomplete')
        # Keep the native owner lock through durable receipt publication and fence removal.
        return complete({'oldResources': len(old), 'removedResources': len(after),
                         'removedIds': [record['Id'] for record, _ in after], 'preservedIds': list(preserved)})


def sync_directory(path, sync=os.fsync):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        sync(fd)
    finally:
        os.close(fd)


def persist_pending(state, sync=os.fsync):
    fd = os.open(state / 'pending', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        sync(fd)
    finally:
        os.close(fd)
    sync_directory(state, sync)
    sync_directory(state.parent, sync)


def execute_durable(options, state=STATE, invoke=command, owner_lock=None, sync=os.fsync,
                    boot_id=lambda: Path('/proc/sys/kernel/random/boot_id').read_text().strip()):
    persist_pending(state, sync)
    def complete(result):
        receipt = {**options, **result, 'bootId': boot_id(),
                   'finishedAt': datetime.now(timezone.utc).isoformat()}
        temporary = state / f'receipt-{os.getpid()}.json'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'w', closefd=False) as stream:
                json.dump(receipt, stream)
                stream.flush()
                sync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, state / 'receipt.json')
        sync_directory(state, sync)
        try:
            try:
                (state / 'owner-started').unlink()
            except FileNotFoundError:
                pass
            (state / 'pending').unlink()
            sync_directory(state, sync)
        except BaseException:
            try:
                persist_pending(state, sync)
            except OSError:
                pass
            raise
        return receipt
    return execute_barrier(options, invoke, owner_lock or (lambda: locked(state / "owner.lock")), complete)


def immutable_reference(reference, role):
    pattern = rf'ghcr\.io/ecryptoguru/(?:lyrashield-ai/)?lyrashield-{role}(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{{64}}'
    return bool(re.fullmatch(pattern, reference))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('worker-image', 'sandbox-image', 'network', 'confirm'):
        parser.add_argument(f'--{option}', required=True)
    args = parser.parse_args()
    if os.getuid() != 0:
        raise RuntimeError('Cold barrier requires root on the exclusive host')
    if any(os.environ.get(key) for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')):
        raise RuntimeError('Remote Docker configuration is forbidden')
    for role, reference in (('worker', args.worker_image), ('sandbox', args.sandbox_image)):
        if not immutable_reference(reference, role):
            raise RuntimeError('Exact immutable old worker/sandbox references are required')
    if args.confirm != 'COLD_SINGLE_WORKER' or args.network != 'lyrashield-sandbox':
        raise RuntimeError('Cold single-worker confirmation and sandbox network are required')
    STATE.mkdir(parents=True, mode=0o700, exist_ok=True)
    metadata = STATE.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise RuntimeError('Cold barrier state directory ownership is invalid')
    options = {'workerImage': args.worker_image, 'sandboxImage': args.sandbox_image, 'network': args.network}
    with locked(STATE / 'operator.lock'):
        print(json.dumps(execute_durable(options)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
