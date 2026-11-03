#!/usr/bin/env python3
"""Rehearse a paid-claim crash against one preloaded immutable worker image.

Only synthetic data, an internal network and disposable services are used. The
worker's application source and executables are never mounted or replaced.
The driver is sent on stdin and instruments process/HTTP dispatch fail closed.
The output is a local rehearsal receipt, not a CI/OIDC qualification attestation.
"""
import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SELECTOR = ROOT / '.github/scripts/worker-evidence-drill-selection.mjs'
DRIVER = ROOT / '.github/scripts/worker-financial-fence-driver.mjs'
ROLE = ROOT / '.github/scripts/disposable-worker-rehearsal-role.sql'
PG = 'postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab'
REDIS = 'redis:7-alpine@sha256:8da19c7399dca900c6822a1cf30f9d2285585e2c4b457ff4095b0f4500054d3f'

def run(args, *, data=None, timeout=30):
    p = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if p.returncode:
        # Command arguments contain disposable credentials; do not print them.
        kind = Path(args[0]).name + (' ' + args[1] if args[0] == 'docker' else '')
        err = p.stderr.decode(errors='replace')
        match = re.search(r'(?m)^(?:ERROR|FATAL|psql: error): [^\n]{1,160}', err)
        detail = ': ' + match.group(0) if match else ''
        raise RuntimeError(f'{kind} command failed ({p.returncode}){detail}')
    return p.stdout.decode().strip()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', nargs=3, required=True, metavar=('IMAGE_DIGEST','PRODUCT_SHA','ENGINE_SHA'))
    parser.add_argument('--receipt', required=True, help='new path to write the passed or failed JSON receipt')
    args = parser.parse_args()
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    image, product, engine = args.candidate
    output = Path(args.receipt).absolute()
    if output.exists() or output.is_symlink():
        raise SystemExit('receipt path already exists')
    prefix = 'lyra-fin-' + uuid.uuid4().hex[:16]
    label = 'lyrashield.financial-drill=' + prefix
    net = prefix+'-net'
    result = {'schema':'lyrashield.worker-financial-crash.v1', 'passed':False,
              'candidate':{'workerImage':image,'productRevision':product,'engineRevision':engine},
              'proofKind':'disposable-actual-image-worker-lifetime-crash',
              'limitations':['local fixture receipt is not a signed CI qualification',
                             'fixture instruments and blocks process and HTTP dispatch',
                             'physical provider budget ceiling requires separate engine CI proof']}
    procs = []
    created = False
    cleanup_ok = False
    try:
        run(['node',str(SELECTOR),'validate','--candidate',image,product,engine])
        def verify_harness():
            if run(['git','--no-replace-objects','-C',str(ROOT),'rev-parse','HEAD']) != product:
                raise RuntimeError('checkout HEAD differs from candidate product revision')
            hashes = {}
            for path in ('.github/scripts/run-worker-financial-fence-drill.py',
                         '.github/scripts/worker-financial-fence-driver.mjs',
                         '.github/scripts/worker-evidence-drill-selection.mjs',
                         '.github/scripts/disposable-worker-rehearsal-role.sql'):
                actual = ROOT / path
                if actual.is_symlink() or not actual.is_file(): raise RuntimeError('harness source is not a regular file')
                blob = subprocess.run(['git','--no-replace-objects','-C',str(ROOT),'show',product+':'+path],
                                      stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
                if blob.returncode or blob.stdout != actual.read_bytes():
                    raise RuntimeError('harness source differs from candidate commit: '+path)
                hashes[path] = hashlib.sha256(blob.stdout).hexdigest()
            return hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        result['harnessFingerprint'] = verify_harness()
        for ref in (image,PG,REDIS): run(['docker','image','inspect',ref])
        with tempfile.TemporaryDirectory(prefix='worker-financial-fence-') as td:
            tmp = Path(td); proof = tmp/'proof'; proof.mkdir(mode=0o777); os.chmod(proof,0o777)
            run(['node',str(SELECTOR),'prepare',str(ROOT),str(tmp),'--candidate',image,product,engine])
            manifest = json.loads((tmp/'reader-selection.json').read_text())
            critical_paths = [
                'apps/worker/src/jobs/run-scan.job.ts',
                'apps/worker/src/jobs/run-scan/execution.ts',
                'apps/worker/src/jobs/run-scan/capacity-lifecycle.ts',
                'apps/worker/src/jobs/run-scan/lifecycle-guards.ts',
                'apps/worker/src/jobs/run-scan/pending-finalization.ts',
                'apps/worker/src/engine/runner-process.ts',
                'packages/db/src/scan-billable-claim.ts',
                'packages/db/src/scan-retry.ts',
                'packages/db/src/scan-service.ts',
                'packages/billing/src/usage/capacity.ts',
            ]
            source_hashes = {}
            for path in critical_paths:
                blob = subprocess.run(['git','--no-replace-objects','-C',str(ROOT),'show',product+':'+path],
                                      stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
                if blob.returncode: raise RuntimeError('critical candidate Git source unavailable: '+path)
                source_hashes[path] = hashlib.sha256(blob.stdout).hexdigest()
            result['financialSourceFingerprint'] = hashlib.sha256(json.dumps(source_hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            inspect = run(['docker','image','inspect',image])
            meta = json.loads(inspect)[0]
            if image not in (meta.get('RepoDigests') or []): raise RuntimeError('canonical worker digest mismatch')
            labels = meta['Config'].get('Labels') or {}
            if labels.get('org.opencontainers.image.revision') != product or labels.get('io.lyrashield.engine.revision') != engine:
                raise RuntimeError('worker image revision labels mismatch')
            # The established reader selector checks the selected source bytes inside
            # this exact image. Send the selector on stdin; never mount it over image code.
            js = SELECTOR.read_bytes()+b'''
checkReaderSources(JSON.parse(process.env.LYRA_READER_MANIFEST));
const financialRequire = (await import('node:module')).createRequire(import.meta.url);
const financialDirname = (await import('node:path')).dirname;
const financialJoin = (await import('node:path')).join;
const financialRoots = {
  'apps/worker/': '/app/apps/worker/',
  'packages/db/src/': financialDirname(financialRequire.resolve('@lyrashield/db')) + '/',
  'packages/billing/src/': financialDirname(financialRequire.resolve('@lyrashield/billing')) + '/'
};
for (const [path,expected] of Object.entries(JSON.parse(process.env.LYRA_FINANCIAL_SOURCES))) {
  const prefix = Object.keys(financialRoots).find(p => path.startsWith(p));
  assert.ok(prefix, 'unknown financial source prefix');
  assert.equal(hash(readFileSync(financialJoin(financialRoots[prefix], path.slice(prefix.length)))), expected, 'candidate financial source mismatch: '+path);
}
console.log('reader-and-financial-source-match');
'''
            preflight = ['docker','run','--rm','-i','--pull','never','--name',prefix+'-reader','--label',label,
                '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
                '--cpus','.5','--memory','256m','--pids-limit','32','--workdir','/app/apps/worker',
                '--env','LYRA_READER_MANIFEST='+json.dumps(manifest,separators=(',',':')),
                '--env','LYRA_FINANCIAL_SOURCES='+json.dumps(source_hashes,separators=(',',':')),
                '--entrypoint','node',image,'--import','tsx','--input-type=module','-']
            created = True  # Includes timed-out preflight containers in cleanup.
            if run(preflight,data=js,timeout=90) != 'reader-and-financial-source-match': raise RuntimeError('candidate source preflight mismatch')
            probe = ['docker','run','--rm','-i','--pull','never','--name',prefix+'-capture-probe','--label',label,
                     '--network','none','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=32m',
                     '--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','.5','--memory','256m',
                     '--pids-limit','32','--workdir','/app/apps/worker','--entrypoint','node',image,
                     '--import','tsx','--input-type=module','-','instrumentation-probe']
            if run(probe,data=DRIVER.read_bytes(),timeout=90) != 'capture-at-import-dispatch-denied':
                raise RuntimeError('in-image import-time dispatch instrumentation probe failed')
            result['inImageCaptureProbe'] = 'passed'
            created = True
            run(['docker','network','create','--internal','--label',label,net])
            if run(['docker','network','inspect','--format','{{.Internal}}',net]) != 'true': raise RuntimeError('network not internal')
            common = ['--pull','never','--label',label,'--network',net,'--security-opt','no-new-privileges','--pids-limit','128']
            run(['docker','run','-d',*common,'--name',prefix+'-postgres','--network-alias','postgres','--cpus','.5','--memory','512m',
                '--env','POSTGRES_USER=lyrashield','--env','POSTGRES_DB=lyrashield','--env','POSTGRES_PASSWORD=disposable-only',PG,'-c','max_connections=50'])
            run(['docker','run','-d',*common,'--name',prefix+'-redis','--network-alias','redis','--cpus','.25','--memory','128m',REDIS,'redis-server','--save','','--appendonly','no'])
            def pg(sql,timeout=30):
                return run(['docker','exec','-i',prefix+'-postgres','psql','-X','-q','-t','-A','-U','lyrashield','-d','lyrashield','-v','ON_ERROR_STOP=1'],data=sql.encode(),timeout=timeout)
            def wait_for(fn, message, seconds=60):
                until=time.monotonic()+seconds
                while time.monotonic()<until:
                    if fn(): return
                    time.sleep(.2)
                raise RuntimeError(message)
            def ready():
                try: return pg('SELECT 1;',timeout=5)=='1' and run(['docker','exec',prefix+'-redis','redis-cli','ping'],timeout=5)=='PONG'
                except (RuntimeError,subprocess.TimeoutExpired): return False
            wait_for(ready,'disposable services not ready',90)
            pg((tmp/'migrations.sql').read_text(),timeout=120)
            pg(ROLE.read_text())
            pg('''CREATE FUNCTION fixture_financial_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(54813927); RETURN NEW; END $$;
CREATE TRIGGER fixture_financial_barrier BEFORE INSERT ON "ScanEvent" FOR EACH ROW WHEN (NEW.stage = 'billable_boundary' AND NEW."scanId" = 'fixture-financial-crash') EXECUTE FUNCTION fixture_financial_barrier();''')
            env = ['NODE_ENV=test','LYRASHIELD_TEST_DB_DISPOSABLE=1',
                   'DATABASE_URL=postgresql://app_runtime_ci:runtime-ci-only@postgres:5432/lyrashield',
                   'DATABASE_DIRECT_URL=postgresql://lyrashield:disposable-only@postgres:5432/lyrashield',
                   'DATABASE_SYSTEM_URL=postgresql://lyrashield:disposable-only@postgres:5432/lyrashield',
                   'REDIS_URL=redis://redis:6379','S3_ENDPOINT=http://s3:9000','S3_BUCKET=fixture',
                   'S3_REGION=us-east-1','S3_ACCESS_KEY=fixture-only','S3_SECRET_KEY=fixture-only',
                   'LYRASHIELD_EVIDENCE_KEK=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                   'LYRASHIELD_EVIDENCE_KEK_KEYRING={}','BETTER_AUTH_SECRET=disposable-auth-only-not-used-for-login-32chars',
                   'BETTER_AUTH_URL=http://127.0.0.1:3100','NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100',
                   'POLAR_PRODUCT_IDS={"pro_monthly":"fixture-worker-smoke-pro-monthly"}',
                   'STRIX_SANDBOX_MEM_LIMIT=1m','STRIX_SANDBOX_CPUS=1','STRIX_SANDBOX_MIN_DISK_MB=1',
                   'LYRASHIELD_LLM=openai/gpt-6-luna',
                   'LYRASHIELD_PRODUCT_REVISION='+product,'LYRASHIELD_ENGINE_REVISION='+engine,'LYRASHIELD_WORKER_IMAGE_DIGEST='+image.split('@')[1]]
            def worker(phase):
                cmd=['docker','run','-i',*common,'--name',prefix+'-'+phase,'--cap-drop','ALL','--read-only',
                     '--cpus','.75','--memory','768m','--tmpfs','/tmp:rw,nosuid,nodev,size=64m',
                     '--mount',f'type=bind,src={proof},dst=/proof','--workdir','/app/apps/worker']
                for value in env: cmd.extend(['--env',value])
                cmd.extend(['--entrypoint','node',image,'--import','tsx','--input-type=module','-',phase])
                log = open(tmp/(phase+'.log'),'wb')
                p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                procs.append((p,log)); p.stdin.write(DRIVER.read_bytes());p.stdin.close()
                return p
            def phase_failed(phase):
                # Synthetic-only container environment; expose bounded error classes,
                # never arbitrary logs or command lines that could contain secrets.
                text = (tmp/(phase+'.log')).read_text(errors='replace')
                matches = re.findall(r'(?m)^(?:Error|AssertionError|TypeError|SyntaxError|ReferenceError|PrismaClient\w+Error)(?: \[[A-Z_]+\])?: [^\n]{1,160}', text)
                return '; '.join(matches[-3:]) or 'no classified error'
            init=worker('init')
            if init.wait(timeout=90)!=0: raise RuntimeError('fixture seed worker failed: '+phase_failed('init'))
            original_identity=json.loads((proof/'identity.json').read_text())
            def sql_session(name,sql):
                p=subprocess.Popen(['docker','exec','-i','-e','PGAPPNAME='+name,prefix+'-postgres','psql','-X','-q','-t','-A','-U','lyrashield','-d','lyrashield','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
                procs.append((p,None));p.stdin.write(sql.encode());p.stdin.flush();return p
            blocker=sql_session('fixture_advisory','SELECT pg_advisory_lock(54813927);\n')
            wait_for(lambda:pg("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='fixture_advisory' AND l.locktype='advisory' AND l.granted);")=='t','advisory barrier not acquired')
            orig=worker('original')
            def original_alive():
                if orig.poll() is not None: raise RuntimeError('original worker exited before claim barrier: '+phase_failed('original'))
                return True
            wait_for(lambda:original_alive() and pg("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.usename='app_runtime_ci' AND l.locktype='advisory' AND NOT l.granted);")=='t','worker did not reach claim barrier',90)
            result['workerClaimTriggerWaitObserved'] = True
            locker=sql_session('fixture_scan_locker','BEGIN; LOCK TABLE "Scan" IN ACCESS EXCLUSIVE MODE;\n')
            wait_for(lambda:pg("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='fixture_scan_locker' AND l.relation='\"Scan\"'::regclass AND l.mode='AccessExclusiveLock' AND NOT l.granted);")=='t','scan table lock was not queued')
            result['queuedTableLockObserved'] = True
            blocker.stdin.write(b'SELECT pg_advisory_unlock(54813927);\n');blocker.stdin.flush()
            wait_for(lambda:original_alive() and pg("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='fixture_scan_locker' AND l.relation='\"Scan\"'::regclass AND l.mode='AccessExclusiveLock' AND l.granted);")=='t','queued scan lock did not acquire')
            # Prove a candidate DB session is actually blocked behind our acquired
            # table lock, rather than merely assuming the dispatch gap was hit.
            wait_for(lambda:original_alive() and pg("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.usename='app_runtime_ci' AND l.relation='\"Scan\"'::regclass AND NOT l.granted);")=='t','worker did not block on scan table after claim')
            if pg("SELECT count(*) FROM \"ScanEvent\" WHERE \"scanId\"='fixture-financial-crash' AND stage='billable_boundary';")!='1': raise RuntimeError('expected exactly one committed billable claim')
            if pg("SELECT count(*) FROM \"ScanResultManifest\" WHERE \"scanId\"='fixture-financial-crash';")!='0': raise RuntimeError('manifest already exists')
            lua="if redis.call('LPOS',KEYS[1],ARGV[1]) and redis.call('HGET',KEYS[2],'ats')=='1' then return redis.call('PTTL',KEYS[3]) end return -2"
            ttl=run(['docker','exec',prefix+'-redis','redis-cli','--raw','EVAL',lua,'3','bull:scans:active','bull:scans:fixture-financial-crash','bull:scans:fixture-financial-crash:lock','fixture-financial-crash'])
            if not re.fullmatch(r'[0-9]+',ttl) or int(ttl)<=0: raise RuntimeError('original job not active with a valid lock')
            result.update({'workerBlockedAfterCommitObserved':True,'claimCount':1,'manifestCount':0,'originalLockTtlMs':int(ttl)})
            # Image identity, process PID and mounts are read from the running container.
            info=json.loads(run(['docker','inspect',prefix+'-original']))[0]
            if info['Image']!=meta['Id'] or not info['State']['Running'] or info['State']['Pid']<=0: raise RuntimeError('running worker identity mismatch')
            if len(info['Mounts'])!=1 or info['Mounts'][0]['Destination']!='/proof': raise RuntimeError('unexpected worker mounts')
            result.update({'originalJob':original_identity,'originalAttemptsStarted':1,'originalContainerPid':info['State']['Pid'],'mountDestinations':['/proof'],'internalNetwork':True,'readerFingerprint':manifest['fingerprint']})
            if (proof/'dispatch-attempts').exists(): raise RuntimeError('process or HTTP dispatch attempted before crash')
            run(['docker','kill','--signal','KILL',prefix+'-original'])
            if orig.wait(timeout=30)!=137: raise RuntimeError('original worker did not exit 137')
            if json.loads(run(['docker','inspect',prefix+'-original']))[0]['State']['ExitCode']!=137: raise RuntimeError('container exit code mismatch')
            result['originalExitCode']=137
            locker.stdin.write(b'ROLLBACK;\n');locker.stdin.flush()
            recovered=worker('recover')
            if recovered.wait(timeout=90)!=0: raise RuntimeError('redelivery worker failed: '+phase_failed('recover'))
            recovery=json.loads((proof/'recovery.json').read_text())
            if any(recovery[k]!=original_identity[k] for k in ('timestamp','nonce')) or recovery['jobId']!=original_identity['id']: raise RuntimeError('redelivery identity mismatch')
            if (proof/'dispatch-attempts').exists(): raise RuntimeError('process or HTTP dispatch attempted')
            if verify_harness() != result['harnessFingerprint']: raise RuntimeError('harness changed during rehearsal')
            result.update({'passed':True,'originalJob':original_identity,'originalAttemptsStarted':1,'claimCount':1,'manifestCount':0,
                           'queuedTableLockObserved':True,'workerBlockedAfterCommitObserved':True,'originalLockTtlMs':int(ttl),
                           'originalContainerPid':info['State']['Pid'],'originalExitCode':137,'recovery':recovery,
                           'mountDestinations':['/proof'],'internalNetwork':True,'readerFingerprint':manifest['fingerprint']})
    except (Exception,KeyboardInterrupt) as exc:
        result['error'] = f'{type(exc).__name__}: {exc}'
    finally:
        for p,log in procs:
            if p.poll() is None:
                try: os.killpg(p.pid,signal.SIGKILL)
                except ProcessLookupError: pass
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: pass
            if log: log.close()
        try:
            if created:
                for find,remove in [(['ps','-aq'],['rm','-fv']),(['network','ls','-q'],['network','rm'])]:
                    ids=run(['docker',*find,'--filter','label='+label]).split()
                    if ids: run(['docker',*remove,*ids],timeout=30)
                    if run(['docker',*find,'--filter','label='+label]): raise RuntimeError('owned resources remain')
            cleanup_ok=True
        except (Exception,KeyboardInterrupt) as exc:
            result['cleanupError']=f'{type(exc).__name__}: {exc}'
        result['cleanupVerified']=cleanup_ok
        result['passed']=bool(result['passed'] and cleanup_ok)
        with output.open('x',encoding='utf8') as f: json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps({'passed':result['passed'],'receipt':str(output),'cleanupVerified':cleanup_ok}))
    return 0 if result['passed'] else 1
if __name__ == '__main__':
    sys.exit(main())
