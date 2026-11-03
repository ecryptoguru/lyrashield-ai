"""Failure controls for the unsigned offline physical-ceiling rehearsal."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'run-engine-physical-ceiling-drill.py'
spec = importlib.util.spec_from_file_location('physical_ceiling_drill', SCRIPT)
drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drill)


class PhysicalCeilingDrillTests(unittest.TestCase):
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
