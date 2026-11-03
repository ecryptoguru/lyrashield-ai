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
import signal
import socket
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
LINUX_GUARD = Path(__file__).with_name('physical-network-guard-linux.py')
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


def invoke(args, *, cwd=None, env=None, data=None, timeout=1200, pass_fds=()):
    result = subprocess.run(args, cwd=cwd, env=env, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, pass_fds=pass_fds)
    if result.returncode:
        # This harness receives no secrets; expose bounded diagnostic output only.
        diagnostics = (result.stdout + b'\n' + result.stderr).decode(errors='replace')[-3000:]
        raise RuntimeError(f'{Path(args[0]).name} failed ({result.returncode}): ' + diagnostics)
    return result.stdout


def _materialize_commit(repo, dest, commit):
    env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(dest.parent),
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
           'GIT_NO_REPLACE_OBJECTS': '1', 'LC_ALL': 'C'}
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise RuntimeError('invalid engine object ID')
    identity = invoke(['/usr/bin/git', '-C', str(repo), 'rev-parse', '--verify', commit+'^{commit}'], env=env)
    if identity.decode().strip() != commit:
        raise RuntimeError('engine object identity mismatch')
    entries = invoke(['/usr/bin/git','-C',str(repo),'ls-tree','-rz','--full-tree',commit],env=env)
    expected = {}
    for row in entries.split(b'\0'):
        if not row:
            continue
        meta, separator, name = row.partition(b'\t')
        match = re.fullmatch(rb'(100644|100755) blob ([0-9a-f]{40})',meta)
        if not separator or not match:
            raise RuntimeError('unsupported engine tree entry')
        path = Path(os.fsdecode(name))
        if path.is_absolute() or '..' in path.parts or str(path) in expected:
            raise RuntimeError('invalid engine tree path')
        expected[str(path)] = (match.group(1),match.group(2).decode())
    if not expected:
        raise RuntimeError('empty engine tree')
    archive = dest.parent / 'engine.tar'
    with archive.open('xb') as out:
        p = subprocess.run(['/usr/bin/git','-C',str(repo),'archive','--format=tar',commit],
                           env=env, stdout=out, stderr=subprocess.PIPE, timeout=120)
    if p.returncode:
        raise RuntimeError('could not materialize exact engine Git object')
    dest.mkdir(mode=0o700)
    with tarfile.open(archive) as tar:
        for item in tar.getmembers():
            path = Path(item.name)
            if path.is_absolute() or '..' in path.parts or not (item.isfile() or item.isdir()):
                raise RuntimeError('unsafe engine archive entry')
        tar.extractall(dest, filter='data')
    archive.unlink()
    seen = set()
    for path in dest.rglob('*'):
        if path.is_symlink():
            raise RuntimeError('engine archive contains a symbolic link')
        if path.is_dir():
            continue
        name = path.relative_to(dest).as_posix()
        if not path.is_file() or name not in expected:
            raise RuntimeError('engine archive contains an unexpected entry')
        mode, blob = expected[name]
        if bool(path.stat().st_mode & 0o111) != (mode == b'100755'):
            raise RuntimeError('engine archive mode differs from commit')
        contents = path.read_bytes()
        observed = hashlib.sha1(b'blob '+str(len(contents)).encode()+b'\0'+contents).hexdigest()
        if observed != blob:
            raise RuntimeError('engine archive contents differ from commit')
        seen.add(name)
    if seen != set(expected):
        raise RuntimeError('engine archive omitted committed paths')


def materialize(repo, dest):
    _materialize_commit(repo, dest, ENGINE)


def check_results(path):
    root = ET.parse(path).getroot()
    cases = root.findall('.//testcase')
    if not cases or any(case.find(tag) is not None for case in cases for tag in ('failure','error','skipped')):
        raise RuntimeError('engine suite failed, skipped, or produced no cases')
    names = {case.get('name','').split('[',1)[0] for case in cases}
    if not set(REQUIRED_TESTS).issubset(names):
        raise RuntimeError('engine suite omitted a required named test')
    return len(cases)


def network_guard(python, cwd, env):
    if sys.platform == 'darwin':
        prefix = ['/usr/bin/sandbox-exec','-p','(version 1) (allow default) (deny network*)']
    elif sys.platform == 'linux':
        prefix = [str(python),'-I',str(LINUX_GUARD)]
    else:
        raise RuntimeError('no qualified network isolation for this platform')
    # The endpoints are deliberately live and also tested outside the guard.
    # Refusal, timeout, missing paths or a fake no-listener failure is not proof.
    with tempfile.TemporaryDirectory(prefix='physical-net-',dir='/tmp') as root:
        tcp = socket.socket(socket.AF_INET,socket.SOCK_STREAM)
        unix = socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        datagram = socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)
        try:
            tcp.bind(('127.0.0.1',0)); tcp.listen(2); tcp.settimeout(2)
            unix_path = str(Path(root)/'stream')
            unix.bind(unix_path); unix.listen(2); unix.settimeout(2)
            datagram_path = str(Path(root)/'datagram')
            datagram.bind(datagram_path); datagram.settimeout(2)
            with socket.create_connection(tcp.getsockname(),timeout=2):
                accepted, _ = tcp.accept(); accepted.close()
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as local:
                local.connect(unix_path); accepted, _ = unix.accept(); accepted.close()
            with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as local:
                local.sendto(b'canary',datagram_path)
                if datagram.recv(16) != b'canary': raise RuntimeError('datagram control failed')
            code = '''import errno,socket,sys
def denied(fn):
 try: fn()
 except OSError as e:
  if e.errno in (errno.EACCES,errno.EPERM): return
  raise
 raise AssertionError('network operation unexpectedly succeeded')
def tcp():
 with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as s: s.connect(('127.0.0.1',int(sys.argv[1])))
def unix():
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s: s.connect(sys.argv[2])
def datagram():
 with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as s: s.sendto(b'canary',sys.argv[3])
def bind():
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s: s.bind(sys.argv[4])
for operation in (tcp,unix,datagram,bind): denied(operation)
a,b=socket.socketpair(); a.send(b'x'); assert b.recv(1)==b'x'; a.close(); b.close()
'''
            invoke([*prefix,str(python),'-I','-c',code,str(tcp.getsockname()[1]),
                    unix_path,datagram_path,str(Path(root)/'guarded-listener')],
                   cwd=cwd,env=env,timeout=15)
            if sys.platform == 'linux':
                # A deliberately inherited socket with a real queued peer must
                # not allow accept; an already-bound socket must not listen.
                peer = socket.create_connection(tcp.getsockname(),timeout=2)
                bound = socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
                try:
                    bound.bind(str(Path(root)/'bound-not-listening'))
                    inherited = '''import ctypes,errno,platform,socket,sys
for fd,method in ((int(sys.argv[1]),'accept'),(int(sys.argv[2]),'listen')):
 s=socket.socket(fileno=fd)
 try: getattr(s,method)()
 except OSError as e:
  if e.errno in (errno.EPERM,errno.EACCES): s.detach(); continue
  raise
 raise AssertionError(method+' unexpectedly succeeded')
numbers={'x86_64':(43,288),'aarch64':(202,242),'arm64':(202,242)}[platform.machine().lower()]
libc=ctypes.CDLL(None,use_errno=True)
for number in numbers:
 if libc.syscall(number,int(sys.argv[1]),0,0,0) != -1 or ctypes.get_errno() not in (errno.EPERM,errno.EACCES):
  raise AssertionError('accept syscall unexpectedly succeeded')
'''
                    invoke([*prefix,str(python),'-I','-c',inherited,str(tcp.fileno()),
                            str(bound.fileno())],cwd=cwd,env=env,timeout=15,
                           pass_fds=(tcp.fileno(),bound.fileno()))
                finally:
                    peer.close(); bound.close()
        finally:
            tcp.close(); unix.close(); datagram.close()
    return prefix


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


def cleanup_probe(name, owner, image_id, created_id):
    if not isinstance(created_id,str) or not re.fullmatch(r'[0-9a-f]{64}',created_id):
        raise RuntimeError('probe create acknowledgment unavailable; ownership and cleanup are unknown')
    ids = invoke(['docker','ps','-aq','--no-trunc','--filter','id='+created_id],timeout=30).decode().split()
    if not ids:
        return
    if len(ids) != 1 or not re.fullmatch(r'[0-9a-f]{64}', ids[0]):
        raise RuntimeError('probe container identity is ambiguous')
    container = json.loads(invoke(['docker','inspect',ids[0]],timeout=30))[0]
    labels = container.get('Config',{}).get('Labels') or {}
    if (container.get('Id') != ids[0] or container.get('Name') != '/'+name or
        container.get('Image') != image_id or labels.get('lyrashield.physical-drill-owner') != owner or
        created_id != ids[0]):
        raise RuntimeError('refusing cleanup of a container without exact probe ownership')
    invoke(['docker','rm','-f',ids[0]],timeout=30)
    if invoke(['docker','ps','-aq','--no-trunc','--filter','id='+created_id],timeout=30).strip():
        raise RuntimeError('offline probe container cleanup failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', nargs=2, metavar=('IMAGE_DIGEST','PRODUCT_SHA'), required=True)
    parser.add_argument('--engine-repo', required=True)
    parser.add_argument('--receipt', required=True)
    args = parser.parse_args()
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
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
            guard = network_guard(python,source,env)
            invoke([*guard,'uv','sync','--frozen','--offline'],cwd=source,env=env)
            xml = tmp/'results.xml'
            python = tmp/'venv/bin/python'
            invoke([*guard,str(python),'-m','pytest','-p','pytest_asyncio.plugin',
                    '--junitxml='+str(xml),*TESTS],cwd=source,env=env,timeout=1800)
            count = check_results(xml)
            wheel_dir = tmp/'wheels'; wheel_dir.mkdir()
            invoke([*guard,'uv','build','--offline','--wheel','--out-dir',str(wheel_dir)],cwd=source,env=env)
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
            owner = uuid4().hex
            name = 'lyra-physical-proof-' + owner
            created_id = None
            try:
                created = invoke(['docker','create','-i','--pull','never','--name',name,
                              '--label','lyrashield.physical-drill-owner='+owner,
                              '--network','none','--read-only','--cap-drop','ALL',
                              '--security-opt','no-new-privileges','--pids-limit','64',
                              '--memory','768m','--cpus','1','--tmpfs','/tmp:rw,nosuid,nodev,mode=1777,size=64m',
                              '--entrypoint','/opt/lyrashield-venv/bin/python',image,'-I','-c',bootstrap],
                             timeout=30).decode().strip()
                if not re.fullmatch(r'[0-9a-f]{64}',created):
                    raise RuntimeError('invalid created probe container identity')
                created_id = created
                raw = invoke(['docker','start','-a','-i',created_id],data=input_bytes,timeout=180)
            finally:
                # A same-name conflict is not ownership: verify ID, label and image.
                cleanup_probe(name,owner,meta['Id'],created_id)
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
