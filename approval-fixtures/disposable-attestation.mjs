// Disposable-only canonical issuance rehearsal. Never import any collector or mutator.
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
import {fixture} from '../packages/db/scripts/tests/webhook-empty-state-v2-fixture.mjs'
import {canonical,sha256,validateAuthorization,REPOSITORY,WORKFLOW} from '../packages/db/scripts/webhook-empty-state-receipt-v2.mjs'
import {verifyAttestation,attestationArguments,verifyCertificateLinkage} from '../packages/db/scripts/webhook-empty-state-attestation.mjs'
const dir=process.env.RUNNER_TEMP, receiptPath=dir+'/disposable-receipt.json', policyPath=dir+'/disposable-policy.json'
if(process.argv[2]==='prepare') {
  assert.equal(process.env.GITHUB_REF,'refs/heads/main')
  assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch')
  const endpoint = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
  endpoint.searchParams.set('audience','sigstore')
  const response=await fetch(endpoint,{headers:{Authorization:'Bearer '+process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}})
  assert.equal(response.ok,true)
  const token=(await response.json()).value
  const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'))
  assert.equal(claims.repository,REPOSITORY)
  assert.equal(claims.ref,'refs/heads/main')
  assert.equal(claims.sha,process.env.GITHUB_SHA)
  assert.equal(claims.job_workflow_ref,REPOSITORY+'/'+WORKFLOW+'@'+claims.job_workflow_sha)
  assert.match(claims.job_workflow_sha,/^[a-f0-9]{40}$/)
  process.env.WORKFLOW_SHA=claims.job_workflow_sha
  const {receipt,policy}=fixture()
  Object.assign(receipt.authorization,{sourceSha:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,
    originalAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),owner:process.env.GITHUB_RUN_ID+':'+process.env.GITHUB_RUN_ATTEMPT,
    workflowSha:process.env.WORKFLOW_SHA,workflowFileSha256:sha256(readFileSync(WORKFLOW,'utf8')),nonce:'disposable-only-public-fixture-nonce-0000000000',
    issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString()})
  Object.assign(policy,receipt.authorization,{workflowSha:process.env.WORKFLOW_SHA,actorId:process.env.GITHUB_ACTOR_ID,
    workflowFileSha256:sha256(readFileSync(WORKFLOW,'utf8'))})
  writeFileSync(receiptPath,canonical(receipt),{mode:0o600})
  writeFileSync(policyPath,canonical(policy),{mode:0o600})
  writeFileSync(dir+'/disposable-predicate.json',canonical({receiptSha256:sha256(canonical(receipt))}))
  appendFileSync(process.env.GITHUB_ENV,'DISPOSABLE_RECEIPT_SHA256='+sha256(canonical(receipt))+'\n')
} else {
  const receipt=JSON.parse(readFileSync(receiptPath)),policy=JSON.parse(readFileSync(policyPath))
  // Actual discovery/official trust root + all application linkage gates; no mock.
  let passed=false
  for(let attempt=0;attempt<20;attempt++) {
    try { assert.equal(verifyAttestation(receiptPath,receipt,policy),true);passed=true;break }
    catch(error) { if(attempt===19)throw error;await new Promise(resolve=>setTimeout(resolve,2000)) }
  }
  assert.equal(passed,true)
  const gh=args=>{const r=spawnSync('/usr/bin/gh',args,{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/root',GH_HOST:'github.com'}});assert.equal(r.status,0);return JSON.parse(r.stdout)}
  const results=gh(attestationArguments(receiptPath,receipt,policy)),run=gh(['api',`repos/${REPOSITORY}/actions/runs/${receipt.authorization.runId}`]),bytes=readFileSync(WORKFLOW,'utf8')
  const valid=results.find(result=>{try{return verifyCertificateLinkage(result,run,receipt,policy,bytes)}catch{return false}})
  assert.ok(valid)
  // Mutate independently after actual verified result; signed identity/run fields
  // remain fixed, exercising the production linkage checks rather than a fake cert.
  for(const mutate of [
    p=>p.policy.workflowSha='0'.repeat(40),
    p=>p.receipt.authorization.sourceSha='0'.repeat(40),
    p=>p.receipt.authorization.runId='1',
    p=>p.run.run_attempt++,
    p=>p.policy.actorId='1',
    p=>p.receipt.authorization.nonce+='X',
    p=>p.result.verificationResult.statement.subject[0].digest.sha256='0'.repeat(64),
    p=>p.result.verificationResult.signature.certificate.sourceRepositoryURI='https://github.com/disposable/wrong',
  ]) {
    const p=structuredClone({result:valid,run,receipt,policy});mutate(p)
    assert.throws(()=>verifyCertificateLinkage(p.result,p.run,p.receipt,p.policy,bytes))
  }
  // Root authorization separately rejects receipt nonce mutation even without cert.
  validateAuthorization(receipt.authorization,policy)
  const changed=structuredClone(receipt.authorization);changed.nonce+='X'
  assert.throws(()=>validateAuthorization(changed,policy))
  console.log('Disposable exact application verification passed; production remains disabled')
}
