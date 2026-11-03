#!/usr/bin/env python3
"""Produce a local offline physical-budget rehearsal receipt for a preloaded worker image.

This is not an attestation or a release authorization. See the companion document.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from uuid import uuid4
import xml.etree.ElementTree as ET
import zipfile

ENGINE = '992b3d9df696753c7b62a31ea58f1ca5d21055c1'
REPOSITORY = 'ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:'
PROBE = Path(__file__).with_name('engine-physical-ceiling-probe.py')
TESTS = (
    'tests/test_budget_reservations.py',
    'tests/test_e2e_budget_lifecycle.py',
    'tests/test_physical_budget_attempts.py',
    'tests/test_physical_budget_boundaries.py',
    'tests/test_physical_budget_review_round2.py',
    'tests/test_physical_budget_review_round3.py',
    'tests/test_physical_budget_review_round4.py',
    'tests/test_physical_budget_review_round5.py',
)
REQUIRED_TESTS = (
    'test_full_budget_lifecycle_reserve_then_cap',
    'test_one_call_allowance_two_concurrent_calls_single_request',
    'test_cost_limit_counts_reserved_charges',
    'test_bounded_sdk_lost_ack_does_not_replay_under_one_reservation',
    'test_direct_native_lost_ack_has_one_physical_attempt_when_capped',
    'test_real_runner_and_native_http_cannot_replay_bounded_503',
    'test_real_litellm_and_native_http_do_not_replay_capped_503',
    'test_native_503_then_success_cannot_hide_a_second_capped_attempt',
    'test_litellm_422_cannot_replay_without_output_cap',
    'test_native_dual_preflight_missing_usage_stops_unless_quote_is_free',
    'test_incomplete_wire_chat_stream_usage_cannot_refund_quote',
    'test_image_recovery_requires_fresh_covered_admission',
    'test_actual_wire_output_cap_cannot_be_removed_or_raised',
    'test_body_callbacks_cannot_rewrite_the_admitted_request',
)
PACKAGES = ('openai', 'openai-agents', 'litellm', 'httpx')
ROOTS = ('lyrashield/', 'lyrashield_adapter/', 'strix/')


def invoke(args, *, cwd=None, env=None, data=None, timeout=1200):
    result = subprocess.run(args, cwd=cwd, env=env, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # This harness receives no secrets; expose bounded diagnostic output only.
        diagnostics = (result.stdout + b'\n' + result.stderr).decode(errors='replace')[-3000:]
        raise RuntimeError(f'{Path(args[0]).name} failed ({result.returncode}): ' + diagnostics)
    return result.stdout


def materialize(repo, dest):
    env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(dest.parent),
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
           'GIT_NO_REPLACE_OBJECTS': '1', 'LC_ALL': 'C'}
    identity = invoke(['/usr/bin/git', '-C', str(repo), 'rev-parse', '--verify', ENGINE+'^{commit}'], env=env)
    if identity.decode().strip() != ENGINE:
        raise RuntimeError('engine object identity mismatch')
    archive = dest.parent / 'engine.tar'
    with archive.open('xb') as out:
        p = subprocess.run(['/usr/bin/git','-C',str(repo),'archive','--format=tar',ENGINE],
                           env=env, stdout=out, stderr=subprocess.PIPE, timeout=120)
    if p.returncode:
        raise RuntimeError('could not materialize exact engine Git object')
    dest.mkdir(mode=0o700)
    with tarfile.open(archive) as tar:
        for item in tar.getmembers():
            path = Path(item.name)
            if path.is_absolute() or '..' in path.parts or not (item.isfile() or item.isdir()):
                raise RuntimeError('unsafe engine archive entry')
        tar.extractall(dest)
    archive.unlink()


def check_results(path):
    root = ET.parse(path).getroot()
    cases = root.findall('.//testcase')
    if not cases or any(case.find(tag) is not None for case in cases for tag in ('failure','error','skipped')):
        raise RuntimeError('engine suite failed, skipped, or produced no cases')
    names = {case.get('name','').split('[',1)[0] for case in cases}
    if not set(REQUIRED_TESTS).issubset(names):
        raise RuntimeError('engine suite omitted a required named test')
    return len(cases)


def check_probe(proof, versions, fingerprint):
    expected_cases = [{'route':api,'streaming':stream,'attempts':1,'outputCap':128}
                      for api in ('responses','chat','litellm') for stream in (False,True)]
    if proof.get('versions') != versions or proof.get('wheelFingerprint') != fingerprint or proof.get('cases') != expected_cases:
        raise RuntimeError('in-image probe did not report the required route cases')
    aggregate = proof.get('aggregate')
    if not isinstance(aggregate, dict) or any(aggregate.get(k) != v for k,v in {
        'concurrentAttempts':2,'fallbackAttempts':1,'deniedAttempts':0,
        'configuredCapUsd':0.002,'priceModel':'openai/gpt-6-luna',
    }.items()):
        raise RuntimeError('in-image aggregate scenario was incomplete')
    if any(type(aggregate.get(key)) is not int for key in ('concurrentAttempts','fallbackAttempts','deniedAttempts')) or type(aggregate.get('configuredCapUsd')) not in (int,float):
        raise RuntimeError('invalid in-image scenario types')
    for key in ('modeledMaximumUsd','heldReservationsUsd','inputRatePerMillion','outputRatePerMillion'):
        value = aggregate.get(key)
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value <= 0:
            raise RuntimeError('invalid in-image cost or price')
    if aggregate['modeledMaximumUsd'] > 0.002 or aggregate['heldReservationsUsd'] > 0.002:
        raise RuntimeError('in-image modeled cost or reservation exceeded cap')
    if aggregate['modeledMaximumUsd'] > aggregate['heldReservationsUsd']:
        raise RuntimeError('modeled wire cost exceeded held reservations')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', nargs=2, metavar=('IMAGE_DIGEST','PRODUCT_SHA'), required=True)
    parser.add_argument('--engine-repo', required=True)
    parser.add_argument('--receipt', required=True)
    args = parser.parse_args()
    image, product = args.candidate
    out = Path(args.receipt).absolute()
    if out.exists() or out.is_symlink():
        raise SystemExit('receipt already exists')
    result = {'schema':'lyrashield.engine-physical-ceiling-local.v1', 'passed':False,
              'candidate':{'workerImage':image,'productRevision':product,'engineRevision':ENGINE},
              'limitations':['unsigned local receipt, not release authorization',
                             'offline synthetic transport, not live provider billing',
                             'suite runs on host; six installed-image route probes run offline',
                             'immutable image provenance must be independently authenticated']}
    try:
        if not re.fullmatch(re.escape(REPOSITORY)+r'[0-9a-f]{64}', image) or not re.fullmatch(r'[0-9a-f]{40}',product):
            raise RuntimeError('invalid canonical immutable image or product revision')
        meta = json.loads(invoke(['docker','image','inspect',image],timeout=30))[0]
        labels = meta.get('Config',{}).get('Labels') or {}
        if image not in (meta.get('RepoDigests') or []) or labels.get('org.opencontainers.image.revision') != product or labels.get('io.lyrashield.engine.revision') != ENGINE:
            raise RuntimeError('image digest or revision labels mismatch')
        cache = invoke(['uv','cache','dir'],timeout=30).decode().strip()
        python = invoke(['uv','python','find','3.12'],timeout=30).decode().strip()
        with tempfile.TemporaryDirectory(prefix='engine-physical-proof-') as tmp:
            tmp = Path(tmp)
            source = tmp/'engine'
            materialize(Path(args.engine_repo).resolve(),source)
            env = {'PATH':os.defpath+':/opt/homebrew/bin:/usr/local/bin', 'HOME':str(tmp),
                   'UV_CACHE_DIR':cache,'UV_NO_CONFIG':'1','UV_OFFLINE':'1','UV_PYTHON_DOWNLOADS':'never',
                   'UV_PROJECT_ENVIRONMENT':str(tmp/'venv'), 'UV_PYTHON':python,
                   'PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1',
                   'PYTHONNOUSERSITE':'1', 'LC_ALL':'C.UTF-8'}
            lock = (source/'uv.lock').read_bytes()
            versions = {}
            for package in tomllib.loads(lock.decode())['package']:
                if package['name'] in PACKAGES:
                    if package['name'] in versions:
                        raise RuntimeError('ambiguous locked provider version')
                    versions[package['name']] = package['version']
            if set(versions) != set(PACKAGES):
                raise RuntimeError('missing locked provider dependency')
            invoke(['uv','sync','--frozen','--offline'],cwd=source,env=env)
            xml = tmp/'results.xml'
            invoke([str(tmp/'venv/bin/python'),'-m','pytest','-p','pytest_asyncio.plugin',
                    '--junitxml='+str(xml),*TESTS],cwd=source,env=env,timeout=1800)
            count = check_results(xml)
            wheel_dir = tmp/'wheels'; wheel_dir.mkdir()
            invoke(['uv','build','--offline','--wheel','--out-dir',str(wheel_dir)],cwd=source,env=env)
            wheels = list(wheel_dir.glob('*.whl'))
            if len(wheels) != 1:
                raise RuntimeError('expected exactly one engine wheel')
            with zipfile.ZipFile(wheels[0]) as z:
                files = {name:hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist()
                         if name.startswith(ROOTS) and not name.endswith('/')}
            if not files or not all(any(name.startswith(root) for name in files) for root in ROOTS):
                raise RuntimeError('wheel missing owned package contents')
            fingerprint = hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            expected = {'versions':versions,'wheelFiles':files,'wheelFingerprint':fingerprint}
            input_bytes = json.dumps(expected,separators=(',',':')).encode()+b'\n'+PROBE.read_bytes()
            bootstrap = 'import json,sys; expected=json.loads(sys.stdin.buffer.readline()); exec(compile(sys.stdin.buffer.read(),"<offline-probe>","exec"))'
            name = 'lyra-physical-proof-' + uuid4().hex
            try:
                raw = invoke(['docker','run','--rm','-i','--pull','never','--name',name,
                              '--network','none','--read-only','--cap-drop','ALL',
                              '--security-opt','no-new-privileges','--pids-limit','64',
                              '--memory','768m','--cpus','1','--tmpfs','/tmp:rw,nosuid,nodev,mode=1777,size=64m',
                              '--entrypoint','/opt/lyrashield-venv/bin/python',image,'-I','-c',bootstrap],
                             data=input_bytes,timeout=180)
            finally:
                # Only this unique container is eligible for cleanup, including timeouts.
                found = invoke(['docker','ps','-aq','--filter','name=^/'+name+'$'],timeout=30).decode().split()
                if found:
                    invoke(['docker','rm','-f',name],timeout=30)
                if invoke(['docker','ps','-aq','--filter','name=^/'+name+'$'],timeout=30).strip():
                    raise RuntimeError('offline probe container cleanup failed')
            proof = json.loads(raw)
            check_probe(proof, versions, fingerprint)
            result.update({'passed':True,'engineTestCases':count,'lockSha256':hashlib.sha256(lock).hexdigest(),
                           'wheelSha256':hashlib.sha256(wheels[0].read_bytes()).hexdigest(),
                           'wheelFingerprint':fingerprint,'installedProbe':proof})
    except (Exception, KeyboardInterrupt) as exc:
        result['error'] = f'{type(exc).__name__}: {exc}'
    with out.open('x',encoding='utf8') as file:
        json.dump(result,file,indent=2,sort_keys=True); file.write('\n')
    print(json.dumps({'passed':result['passed'],'receipt':str(out)}))
    return 0 if result['passed'] else 1

if __name__ == '__main__':
    sys.exit(main())
