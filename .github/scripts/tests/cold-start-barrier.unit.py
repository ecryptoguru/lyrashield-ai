import copy
from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('cold_barrier', ROOT / 'ops/worker/cold-start-barrier.py')
barrier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(barrier)
OPTIONS = {'workerImage': 'ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:' + 'a' * 64,
           'sandboxImage': 'ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:' + 'b' * 64,
           'network': 'lyrashield-sandbox'}
LABELS = {barrier.SOURCE: 'd' * 40, barrier.ENGINE: 'e' * 40}
TRUSTED = {**OPTIONS, 'workerImageId': 'sha256:' + 'a' * 64, 'sandboxImageId': 'sha256:' + 'b' * 64,
           'workerLabels': LABELS}


def sandbox():
    return {'Id': 'c' * 64, 'Image': TRUSTED['sandboxImageId'], 'Name': '/sandbox',
            'Config': {'Image': OPTIONS['sandboxImage'], 'Labels': {'strix-run-id': 'c1234567890123456789012345'}},
            'HostConfig': {'NetworkMode': OPTIONS['network'], 'RestartPolicy': {'Name': 'no'}},
            'Mounts': [{'Type': 'bind', 'Source': '/var/lib/lyrashield/worker/tmp/strix_repos/old'}],
            'State': {'Running': True, 'Pid': 20, 'Paused': False, 'Restarting': False}}


def worker():
    record = sandbox()
    record.update(Id='f' * 64, Image=TRUSTED['workerImageId'], Name='/lyrashield-worker')
    record['Config'] = {'Image': 'ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker:historical@sha256:' + 'a' * 64,
                        'Labels': copy.deepcopy(LABELS)}
    return record


def redis():
    record = sandbox()
    record.update(Id='1' * 64, Image='sha256:' + '2' * 64, Name='/lyrashield-redis')
    record['Config'] = {'Image': 'redis:7', 'Labels': {}}
    record['State'].update(Running=False, Pid=0)
    record['Mounts'] = [{'Type': 'volume', 'Name': 'preserve-volume', 'Source': '/var/lib/docker/volumes/preserve-volume/_data'}]
    return record


class Fixture:
    def __init__(self, resources=None, fail='', delayed=False):
        self.resources = copy.deepcopy(resources if resources is not None else [sandbox(), redis()])
        self.calls, self.fail, self.delayed = [], fail, delayed

    def invoke(self, program, args):
        call = program + ' ' + ' '.join(args)
        self.calls.append(call)
        if self.fail and self.fail in call:
            raise RuntimeError('lost native acknowledgement')
        if program == 'docker' and args[:2] == ['image', 'inspect']:
            image = TRUSTED['workerImageId'] if args[2] == OPTIONS['workerImage'] else TRUSTED['sandboxImageId']
            return json.dumps([{'Id': image, 'Config': {'Labels': LABELS}}])
        if program == 'docker' and args[:2] == ['container', 'ls']:
            return '\n'.join(record['Id'] for record in self.resources)
        if program == 'docker' and args[:2] == ['container', 'inspect']:
            return json.dumps(self.resources)
        if program == 'docker' and args[:2] == ['container', 'rm']:
            self.resources = [record for record in self.resources if record['Id'] != args[-1]]
        if program == 'systemctl' and args[0] == 'show':
            return '0' if '--property=MainPID' in args else 'inactive'
        if call == 'systemctl stop lyrashield-worker.service':
            self.resources = [record for record in self.resources if record['Name'] != '/lyrashield-worker']
        if call == 'systemctl start docker.service' and self.delayed:
            self.resources.append(sandbox())
        return ''


class ColdBarrierTests(unittest.TestCase):
    def execute(self, f):
        return barrier.execute_barrier(OPTIONS, f.invoke, nullcontext)

    def test_cleans_only_owned_sandbox_preserves_stopped_redis_and_volume(self):
        f = Fixture([worker(), sandbox(), redis()])
        receipt = self.execute(f)
        self.assertEqual(receipt['removedIds'], ['c' * 64])
        self.assertEqual(receipt['preservedIds'], ['1' * 64])
        self.assertEqual(f.resources, [redis()])
        self.assertLess(f.calls.index('systemctl stop docker.socket docker.service'),
                        f.calls.index('docker container rm --force ' + 'c' * 64))
        self.assertFalse(any('volume' in call for call in f.calls))

    def test_authenticated_tag_and_tag_at_digest_worker_are_accepted(self):
        for reference in ('mutable-historical-tag', worker()['Config']['Image'], OPTIONS['workerImage']):
            record = worker()
            record['Config']['Image'] = reference
            owned, _ = barrier.classify([record], TRUSTED)
            self.assertTrue(owned[0][1])

    def test_wrong_worker_image_id_or_expected_label_are_rejected(self):
        for mutate in (lambda r: r.update(Image='sha256:' + '3' * 64),
                       lambda r: r['Config']['Labels'].update({barrier.SOURCE: '4' * 40}),
                       lambda r: r['Config']['Labels'].update({barrier.ENGINE: '5' * 40})):
            record = worker()
            mutate(record)
            with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
                barrier.classify([record], TRUSTED)

    def test_immutable_cli_canonical_and_tag_at_digest_allowed_mutable_tags_forbidden(self):
        self.assertTrue(barrier.immutable_reference(OPTIONS['workerImage'], 'worker'))
        self.assertTrue(barrier.immutable_reference(worker()['Config']['Image'], 'worker'))
        self.assertTrue(barrier.immutable_reference(OPTIONS['sandboxImage'], 'sandbox'))
        self.assertFalse(barrier.immutable_reference('ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker:mutable', 'worker'))
        self.assertFalse(barrier.immutable_reference('ghcr.io/foreign/lyrashield-worker@sha256:' + 'a' * 64, 'worker'))

    def test_foreign_active_restartable_paused_or_pid_container_never_stops_owner(self):
        for mutate in (lambda r: r['State'].update(Running=True), lambda r: r['State'].update(Pid=42),
                       lambda r: r['State'].update(Paused=True), lambda r: r['State'].update(Restarting=True),
                       lambda r: r['HostConfig']['RestartPolicy'].update(Name='always')):
            record = redis()
            mutate(record)
            f = Fixture([record])
            with self.assertRaisesRegex(RuntimeError, 'Foreign active'):
                self.execute(f)
            self.assertFalse(any(call.startswith('systemctl ') for call in f.calls))

    def test_bad_sandbox_labels_image_network_or_bind_ownership_is_rejected(self):
        for mutate in (lambda r: r.update(Image='sha256:' + '6' * 64),
                       lambda r: r['Config']['Labels'].update({'strix-run-id': '../escape'}),
                       lambda r: r['HostConfig'].update(NetworkMode='bridge'),
                       lambda r: r['Mounts'][0].update(Source='/foreign'),
                       lambda r: r['HostConfig']['RestartPolicy'].update(Name='always')):
            record = sandbox()
            mutate(record)
            with self.assertRaisesRegex(RuntimeError, 'Unauthenticated'):
                barrier.classify([record], TRUSTED)

    def test_delayed_owned_create_after_initial_inventory_is_removed(self):
        receipt = self.execute(Fixture([redis()], delayed=True))
        self.assertEqual(receipt['removedIds'], ['c' * 64])
        self.assertEqual(receipt['preservedIds'], ['1' * 64])

    def test_foreign_container_activated_after_worker_stop_prevents_daemon_stop(self):
        f = Fixture([worker(), redis()])
        invoke = f.invoke
        def changed(program, args):
            result = invoke(program, args)
            if program == 'systemctl' and args == ['stop', 'lyrashield-worker.service']:
                f.resources[0]['State'].update(Running=True, Pid=42)
            return result
        with self.assertRaisesRegex(RuntimeError, 'Foreign active'):
            barrier.execute_barrier(OPTIONS, changed, nullcontext)
        self.assertNotIn('systemctl stop docker.socket docker.service', f.calls)

    def test_new_foreign_stopped_container_after_daemon_restart_fails(self):
        f = Fixture([])
        invoke = f.invoke
        def changed(program, args):
            result = invoke(program, args)
            if program == 'systemctl' and args == ['start', 'docker.service']:
                f.resources.append(redis())
            return result
        with self.assertRaisesRegex(RuntimeError, 'Preserved stopped-container'):
            barrier.execute_barrier(OPTIONS, changed, nullcontext)
        self.assertFalse(any('container rm' in call for call in f.calls))

    def test_lost_native_acknowledgements_fail_closed(self):
        for failure in ('systemctl stop lyrashield-worker', 'systemctl stop docker.socket',
                        'systemctl start docker.service', 'docker container rm'):
            with self.subTest(failure=failure), self.assertRaisesRegex(RuntimeError, 'lost native acknowledgement'):
                self.execute(Fixture(fail=failure))

    def test_durable_receipt_clears_actual_fences_and_preserves_redis(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state'
            state.mkdir(mode=0o700)
            (state / 'owner-started').touch(mode=0o600)
            receipt = barrier.execute_durable(OPTIONS, state, Fixture().invoke, nullcontext,
                                              boot_id=lambda: 'boot-id')
            self.assertFalse((state / 'pending').exists())
            self.assertFalse((state / 'owner-started').exists())
            self.assertEqual((state / 'receipt.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(receipt['preservedIds'], ['1' * 64])

    def test_six_durability_failure_points_deny_success_and_preserve_fence(self):
        for fail_at in range(1, 7):
            with self.subTest(fail_at=fail_at), tempfile.TemporaryDirectory() as directory:
                state = Path(directory) / 'state'
                state.mkdir(mode=0o700)
                f = Fixture()
                count = 0
                def sync(fd):
                    nonlocal count
                    count += 1
                    if count == fail_at:
                        raise OSError('durability acknowledgement lost')
                    if count <= 3:
                        self.assertFalse(f.calls)
                    if count == 5:
                        self.assertTrue((state / 'receipt.json').exists())
                        self.assertTrue((state / 'pending').exists())
                    os.fsync(fd)
                with self.assertRaisesRegex(OSError, 'durability acknowledgement lost'):
                    barrier.execute_durable(OPTIONS, state, f.invoke, nullcontext, sync, lambda: 'boot-id')
                self.assertTrue((state / 'pending').exists())
                if fail_at <= 3:
                    self.assertFalse(f.calls)

    def test_owner_lock_excludes_launcher_through_failed_final_fsync(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state'
            state.mkdir(mode=0o700)
            (state / 'owner-started').touch(mode=0o600)
            count = 0
            def sync(fd):
                nonlocal count
                count += 1
                if count >= 4:
                    contender = subprocess.run([sys.executable, '-c',
                        'import fcntl,sys; f=open(sys.argv[1], "w"); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)',
                        str(state / 'owner.lock')], capture_output=True)
                    self.assertNotEqual(contender.returncode, 0, 'concurrent launcher acquired owner lock')
                if count == 6:
                    self.assertFalse((state / 'pending').exists())
                    self.assertFalse((state / 'owner-started').exists())
                    raise OSError('final directory sync failed')
                os.fsync(fd)
            with self.assertRaisesRegex(OSError, 'final directory sync failed'):
                barrier.execute_durable(OPTIONS, state, Fixture().invoke, sync=sync, boot_id=lambda: "boot-id")
            self.assertTrue((state / 'pending').exists())
            with barrier.locked(state / 'owner.lock'):
                self.assertTrue((state / 'pending').exists())

    def test_native_ack_failure_keeps_durable_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state'
            state.mkdir(mode=0o700)
            with self.assertRaisesRegex(RuntimeError, 'lost native acknowledgement'):
                barrier.execute_durable(OPTIONS, state, Fixture(fail='systemctl stop').invoke, nullcontext)
            self.assertEqual((state / 'pending').stat().st_mode & 0o777, 0o600)
            self.assertFalse((state / 'receipt.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
