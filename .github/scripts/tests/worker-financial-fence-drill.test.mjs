import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const script = resolve('.github/scripts/run-worker-financial-fence-drill.py')
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lyra-financial-test-'))
  t.after(() => rmSync(dir,{recursive:true,force:true}))
  const marker = join(dir,'docker-called')
  writeFileSync(join(dir,'docker'), `#!/bin/sh\n: > '${marker}'\nexit 99\n`)
  chmodSync(join(dir,'docker'),0o700)
  return {dir,marker,env:{...process.env,PATH:dir+':'+process.env.PATH}}
}

test('invalid candidate fails closed before Docker and persists a failed receipt',t=>{
  const {dir,marker,env} = workspace(t)
  const receipt = join(dir,'receipt.json')
  const result = spawnSync('python3',[script,'--candidate','invalid','0'.repeat(40),'1'.repeat(40),'--receipt',receipt],{env,encoding:'utf8'})
  assert.equal(result.status,1)
  const parsed = JSON.parse(readFileSync(receipt,'utf8'))
  assert.equal(parsed.passed,false)
  assert.equal(parsed.cleanupVerified,true)
  assert.equal(parsed.proofKind,'disposable-actual-image-worker-lifetime-crash')
  assert.equal(existsSync(marker),false)
})

test('an existing receipt is never overwritten or used to start Docker',t=>{
  const {dir,marker,env} = workspace(t)
  const receipt = join(dir,'receipt.json')
  writeFileSync(receipt,'keep original')
  const result = spawnSync('python3',[script,'--candidate','invalid','0'.repeat(40),'1'.repeat(40),'--receipt',receipt],{env,encoding:'utf8'})
  assert.notEqual(result.status,0)
  assert.equal(readFileSync(receipt,'utf8'),'keep original')
  assert.equal(existsSync(marker),false)
})

test('dispatch captured during CJS and ESM initialization remains blocked',()=>{
  const driver = resolve('.github/scripts/worker-financial-fence-driver.mjs')
  const result = spawnSync(process.execPath,[driver,'instrumentation-probe'],{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  assert.equal(result.stdout.trim(),'capture-at-import-dispatch-denied')
})
