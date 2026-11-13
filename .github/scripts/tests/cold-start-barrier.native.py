"""Opt-in real native lifecycle proof in an invocation-owned nested daemon."""
from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('cold_barrier', ROOT / 'ops/worker/cold-start-barrier.py')
barrier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(barrier)
if os.environ.get('LYRASHIELD_RUN_ISOLATED_NATIVE_COLD_PROOF') != '1':
    raise RuntimeError('Set LYRASHIELD_RUN_ISOLATED_NATIVE_COLD_PROOF=1 for the isolated native proof')
HOST = 'lyrashield-cold-proof-' + str(uuid.uuid4())
IMAGE = 'docker.io/library/docker@sha256:08a98015fce594af7c382883bea080ea206de74402a95da9dc52b6428c8cd121'


def outer(args):
    return subprocess.check_output(['docker', *args], text=True, timeout=90)


def inside(args):
    return outer(['exec', HOST, *args])


try:
    outer(['run', '--rm', '--detach', '--name', HOST, '--privileged', '--network=none', '--env',
           'DOCKER_TLS_CERTDIR=', '--entrypoint', 'sh', IMAGE, '-c',
           'dockerd --shutdown-timeout=5 --host=unix:///var/run/docker.sock --pidfile=/run/cold-dockerd.pid >/tmp/dockerd.log 2>&1 & exec tail -f /dev/null'])
    for attempt in range(100):
        try:
            inside(['docker', 'info'])
            break
        except subprocess.CalledProcessError:
            time.sleep(0.1)
    else:
        raise RuntimeError('Isolated daemon did not become ready')
    save = subprocess.Popen(['docker', 'image', 'save', 'docker:29-dind'], stdout=subprocess.PIPE)
    load = subprocess.Popen(['docker', 'exec', '--interactive', HOST, 'docker', 'image', 'load'],
                            stdin=save.stdout, stdout=subprocess.DEVNULL)
    save.stdout.close()
    if load.wait(timeout=90) != 0 or save.wait(timeout=90) != 0:
        raise RuntimeError('Native fixture image transfer failed')
    sandbox_image = inside(['docker', 'image', 'ls', '--all', '--quiet', '--no-trunc']).strip().splitlines()[0]
    labels = {barrier.SOURCE: 'a' * 40, barrier.ENGINE: 'b' * 40}
    builder = inside(['docker', 'create', '--label', f'{barrier.SOURCE}={labels[barrier.SOURCE]}',
                      '--label', f'{barrier.ENGINE}={labels[barrier.ENGINE]}', sandbox_image]).strip()
    worker_image = inside(['docker', 'commit', builder, 'fixture-worker:historical']).strip()
    inside(['docker', 'rm', builder])
    inside(['mkdir', '-p', '/var/lib/lyrashield/worker/tmp/strix_repos/old'])
    inside(['docker', 'network', 'create', '--internal', '--opt',
            'com.docker.network.bridge.enable_icc=false', 'lyrashield-sandbox'])
    inside(['docker', 'run', '--detach', '--name', 'lyrashield-worker', '--network=none',
            '--entrypoint', 'tail', 'fixture-worker:historical', '-f', '/dev/null'])
    redis_id = inside(['docker', 'create', '--name', 'lyrashield-redis', '--network=none',
                       '--mount', 'type=volume,src=preserve-volume,dst=/data',
                       '--entrypoint', 'tail', sandbox_image, '-f', '/dev/null']).strip()

    def create_sandbox():
        return inside(['docker', 'run', '--detach', '--network=lyrashield-sandbox', '--label',
                       'strix-run-id=c1234567890123456789012345', '--mount',
                       'type=bind,src=/var/lib/lyrashield/worker/tmp/strix_repos/old,dst=/work',
                       '--entrypoint', 'tail', sandbox_image, '-f', '/dev/null']).strip()

    scan_id = create_sandbox()
    options = {'workerImage': worker_image, 'sandboxImage': sandbox_image, 'network': 'lyrashield-sandbox'}

    def invoke(program, args):
        if program == 'docker':
            return inside([program, *args])
        if args[0] == 'show':
            return '0' if '--property=MainPID' in args else 'inactive'
        if args == ['stop', 'lyrashield-worker.service']:
            if inside(['docker', 'container', 'ls', '--all', '--quiet', '--filter', 'name=^/lyrashield-worker$']).strip():
                inside(['docker', 'stop', '--time=1', 'lyrashield-worker'])
                inside(['docker', 'rm', 'lyrashield-worker'])
        elif args == ['stop', 'docker.socket', 'docker.service']:
            inside(['sh', '-c', 'pid=$(cat /run/cold-dockerd.pid); kill -TERM "$pid"; for n in $(seq 1 400); do if ! kill -0 "$pid" 2>/dev/null || [ "$(cut -d " " -f 3 /proc/$pid/stat 2>/dev/null)" = Z ]; then exit 0; fi; sleep 0.1; done; exit 1'])
        elif args == ['start', 'docker.service']:
            inside(['sh', '-c', 'dockerd --shutdown-timeout=5 --host=unix:///var/run/docker.sock --pidfile=/run/cold-dockerd.pid >/tmp/dockerd.log 2>&1 & for n in $(seq 1 100); do docker info >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1'])
        return ''

    receipt = barrier.execute_barrier(options, invoke, nullcontext)
    assert receipt['removedIds'] == [scan_id]
    assert receipt['preservedIds'] == [redis_id]
    assert inside(['docker', 'container', 'ls', '--all', '--quiet', '--no-trunc']).strip() == redis_id
    volume = json.loads(inside(['docker', 'volume', 'inspect', 'preserve-volume']))
    assert volume[0]['Name'] == 'preserve-volume'
    lost_id = create_sandbox()

    def lost_ack(program, args):
        result = invoke(program, args)
        if program == 'docker' and args[:2] == ['container', 'rm']:
            raise RuntimeError('lost remove acknowledgement')
        return result

    try:
        barrier.execute_barrier(options, lost_ack, nullcontext)
        raise AssertionError('Lost acknowledgement was accepted')
    except RuntimeError as error:
        assert 'lost remove acknowledgement' in str(error)
    assert inside(['docker', 'container', 'ls', '--all', '--quiet', '--no-trunc']).strip() == redis_id
    print(json.dumps({'nativeDaemonCycle': 'PASS', 'taggedOwnerAuthenticated': 'PASS',
                      'exactSandboxRemoved': scan_id, 'preservedStoppedRedis': redis_id,
                      'preservedVolume': 'preserve-volume', 'lostAcknowledgementRejected': lost_id,
                      'systemdQualification': 'NOT_TESTED'}))
finally:
    outer(['rm', '--force', HOST])
