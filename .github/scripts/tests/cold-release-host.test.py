"""Host receipt regressions; synthetic root metadata is not native qualification."""
import copy
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host', Path(__file__).parents[1] / 'cold-release-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
WORKER = 'ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:' + 'a' * 64
SANDBOX = 'ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:' + 'b' * 64
NEW = 'ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:' + 'c' * 64
OWNER = '42:1'
PRODUCT, ENGINE = 'd' * 40, 'e' * 40


class HostReceipt(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.state = Path(self.directory.name)
        self.receipt = dict(workerImage=WORKER, sandboxImage=SANDBOX, bootId='boot', network='lyrashield-sandbox', removedIds=['f' * 64], finishedAt=(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)).isoformat())
        self.raw = (json.dumps(self.receipt) + '\n').encode()
        (self.state / 'receipt.json').write_bytes(self.raw)
        self.sha = hashlib.sha256(self.raw).hexdigest()
        self.context = dict(identity=dict(owner=OWNER, product=PRODUCT, engine=ENGINE, image=NEW, sandbox=SANDBOX), oldWorker=WORKER, oldSandbox=SANDBOX, barrierSha256=self.sha)
        original_lstat = Path.lstat
        def root_lstat(path):
            value = original_lstat(path)
            fields = list(value)
            fields[0] = (value.st_mode & ~0o777) | 0o700
            fields[4] = 0
            return host.os.stat_result(fields)
        self.patch = patch.object(Path, 'lstat', root_lstat)
        self.patch.start()
        self.reader = patch.object(host, 'read_root_json', side_effect=self.read)
        self.reader.start()

    def read(self, path):
        raw = Path(path).read_bytes()
        return json.loads(raw), hashlib.sha256(raw).hexdigest()

    def tearDown(self):
        self.reader.stop()
        self.patch.stop()
        self.directory.cleanup()

    def verify(self, stopped=lambda: True, context=None):
        return host.verify_barrier(self.state, 'boot', WORKER, SANDBOX, context or self.context, OWNER, NEW, PRODUCT, ENGINE, SANDBOX, stopped)

    def test_actual_completed_receipt_and_exact_release_binding(self):
        self.verify()
        invalid = copy.deepcopy(self.context)
        invalid['barrierSha256'] = '0' * 64
        with self.assertRaises(ValueError):
            self.verify(context=invalid)
        invalid = copy.deepcopy(self.context)
        invalid['identity']['owner'] = '43:1'
        with self.assertRaises(ValueError):
            self.verify(context=invalid)

    def test_late_legacy_owner_and_pending_barrier_stay_closed(self):
        with self.assertRaises(ValueError):
            self.verify(stopped=lambda: False)
        (self.state / 'pending').touch()
        with self.assertRaises(ValueError):
            self.verify()

    def test_only_exact_new_owner_can_follow_this_receipt(self):
        marker = dict(owner=OWNER, workerImage=NEW, productRevision=PRODUCT, engineRevision=ENGINE, bootId='boot', receiptSha256=self.sha, epochSha256='1' * 64)
        (self.state / 'owner-started').write_text(json.dumps(marker))
        self.verify(stopped=lambda: False)
        for field, value in [('owner', '43:1'), ('workerImage', WORKER), ('receiptSha256', '0' * 64), ('bootId', 'different'), ('epochSha256', '')]:
            invalid = dict(marker, **{field: value})
            (self.state / 'owner-started').write_text(json.dumps(invalid))
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.verify()
        (self.state / 'owner-started').write_text('')
        with self.assertRaises(ValueError):
            self.verify()

    def test_tampered_receipt_and_boot_never_qualify(self):
        for field, value in [('bootId', 'other'), ('workerImage', NEW), ('removedIds', ['bad']), ('network', 'other')]:
            (self.state / 'receipt.json').write_text(json.dumps(dict(self.receipt, **{field: value})))
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.verify()


if __name__ == '__main__':
    unittest.main()
