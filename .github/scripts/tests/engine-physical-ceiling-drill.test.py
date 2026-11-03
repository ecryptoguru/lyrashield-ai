"""Failure controls for the unsigned offline physical-ceiling rehearsal."""
import importlib.util
import os
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'run-engine-physical-ceiling-drill.py'
spec = importlib.util.spec_from_file_location('physical_ceiling_drill', SCRIPT)
drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drill)


class PhysicalCeilingDrillTests(unittest.TestCase):
    def test_network_guard_blocks_live_inet_and_unix_endpoints(self):
        self.assertTrue(drill.network_guard(sys.executable,os.getcwd(),dict(os.environ)))

    def test_cleanup_refuses_name_conflict_and_removes_only_owned_timeout_container(self):
        cid, owner, image, name = 'a'*64, 'b'*32, 'sha256:'+'c'*64, 'fixture-probe'
        def response(label, actual_image=image):
            return json.dumps([{'Id':cid,'Name':'/'+name,'Image':actual_image,
                                'Config':{'Labels':{'lyrashield.physical-drill-owner':label}}}]).encode()
        # Matching name, label and image do not prove ownership without the
        # acknowledged container ID; do not even attempt a deletion by lookup.
        with patch.object(drill,'invoke',side_effect=AssertionError('unexpected Docker call')):
            with self.assertRaisesRegex(RuntimeError,'acknowledgment'):
                drill.cleanup_probe(name,owner,image,None)
        for label, actual_image, created in [('foreign',image,cid),(owner,'sha256:'+'d'*64,cid),
                                             (owner,image,'e'*64)]:
            calls = []
            def foreign(args, **_kwargs):
                calls.append(args)
                if args[1] == 'ps': return (cid+'\n').encode()
                if args[1] == 'inspect': return response(label,actual_image)
                raise AssertionError('foreign container was removed')
            with patch.object(drill,'invoke',side_effect=foreign):
                with self.assertRaises(RuntimeError): drill.cleanup_probe(name,owner,image,created)
            self.assertFalse(any(args[1] == 'rm' for args in calls))
        calls = []
        def owned(args, **_kwargs):
            calls.append(args)
            if args[1] == 'ps': return (cid+'\n').encode() if len(calls) == 1 else b''
            if args[1] == 'inspect': return response(owner)
            if args[1] == 'rm': return (cid+'\n').encode()
            raise AssertionError(args)
        with patch.object(drill,'invoke',side_effect=owned):
            drill.cleanup_probe(name,owner,image,cid)
        self.assertEqual([args for args in calls if args[1] == 'rm'],[['docker','rm','-f',cid]])

    def test_materialization_rejects_local_archive_attributes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root/'repo'
            repo.mkdir()
            def git(*args):
                return subprocess.run(['/usr/bin/git','-C',str(repo),*args],check=True,
                                      capture_output=True,text=True).stdout.strip()
            git('init','-q')
            (repo/'README.md').write_text('commit $Format:%H$\n')
            (repo/'tests').mkdir()
            (repo/'tests/conftest.py').write_text('# required socket guard\n')
            script = repo/'script.sh'
            script.write_text('#!/bin/sh\nexit 0\n')
            script.chmod(0o755)
            git('add','README.md','script.sh','tests/conftest.py')
            git('-c','user.email=fixture@example.invalid','-c','user.name=Fixture',
                '-c','core.hooksPath=/dev/null','commit','-qm','fixture')
            commit = git('rev-parse','HEAD')
            attrs = repo/'.git/info/attributes'
            for index, rule in enumerate(('README.md export-ignore\n',
                                          'tests/conftest.py export-ignore\n',
                                          'README.md export-subst\n')):
                attrs.write_text(rule)
                parent = root/('bad-'+str(index))
                parent.mkdir()
                with self.assertRaises(RuntimeError):
                    drill._materialize_commit(repo,parent/'engine',commit)
            attrs.unlink()
            parent = root/'good'
            parent.mkdir()
            drill._materialize_commit(repo,parent/'engine',commit)
            self.assertEqual((parent/'engine/README.md').read_text(),'commit $Format:%H$\n')
            self.assertTrue(os.access(parent/'engine/script.sh',os.X_OK))

    def test_aggregate_requires_all_scenarios_and_finite_bounded_numbers(self):
        versions = {'openai':'2.48.0'}
        cases = [{'route':api,'streaming':stream,'attempts':1,'outputCap':128}
                 for api in ('responses','chat','litellm') for stream in (False,True)]
        aggregate = {'concurrentAttempts':2,'fallbackAttempts':1,'deniedAttempts':0,
                     'configuredCapUsd':0.002,'priceModel':'openai/gpt-6-luna',
                     'modeledMaximumUsd':0.0007,'heldReservationsUsd':0.0018,
                     'inputRatePerMillion':0.125,'outputRatePerMillion':0.5}
        good = {'versions':versions,'wheelFingerprint':'fixture','cases':cases,'aggregate':aggregate}
        drill.check_probe(good, versions, 'fixture')
        for patch in ({'modeledMaximumUsd':0.003},{'modeledMaximumUsd':0.0019},
                      {'heldReservationsUsd':float('nan')},
                      {'deniedAttempts':False},{'fallbackAttempts':0},{'outputRatePerMillion':0}):
            with self.assertRaises(RuntimeError):
                drill.check_probe({**good,'aggregate':{**aggregate,**patch}},versions,'fixture')

    def junit(self, directory, extra='', omit=None):
        names = [name for name in drill.REQUIRED_TESTS if name != omit]
        cases = ''.join('<testcase name="'+name+'"/>' for name in names)
        result = Path(directory)/'result.xml'
        result.write_text('<testsuites><testsuite>'+cases+extra+'</testsuite></testsuites>')
        return result

    def test_suite_requires_every_named_case_and_rejects_skips_and_failures(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(drill.check_results(self.junit(tmp)),len(drill.REQUIRED_TESTS))
            for xml in ('<testcase name="other"><skipped/></testcase>',
                        '<testcase name="other"><failure/></testcase>',
                        '<testcase name="other"><error/></testcase>'):
                with self.assertRaises(RuntimeError): drill.check_results(self.junit(tmp,xml))
            with self.assertRaises(RuntimeError):
                drill.check_results(self.junit(tmp,omit=drill.REQUIRED_TESTS[0]))

    def test_invalid_candidate_emits_failed_receipt_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt = Path(tmp)/'receipt.json'
            command = [sys.executable,str(SCRIPT),'--candidate','not-an-image','a'*40,
                       '--engine-repo',tmp,'--receipt',str(receipt)]
            first=subprocess.run(command,capture_output=True,text=True,check=False)
            self.assertNotEqual(first.returncode,0)
            contents=receipt.read_bytes()
            self.assertFalse(json.loads(contents)['passed'])
            self.assertIn('invalid canonical',json.loads(contents)['error'])
            second=subprocess.run(command,capture_output=True,text=True,check=False)
            self.assertNotEqual(second.returncode,0)
            self.assertEqual(receipt.read_bytes(),contents)


if __name__ == '__main__':
    unittest.main()
