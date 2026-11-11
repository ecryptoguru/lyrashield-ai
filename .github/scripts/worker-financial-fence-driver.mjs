// Test-only orchestrator, evaluated on stdin inside the immutable worker image.
// It instruments process/HTTP dispatch to fail closed, but imports and executes the
// candidate's unmodified processScanJob and its installed dependencies.
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const require = createRequire(import.meta.url)
const phase = process.argv[2]
const probeEvents = []
const deny = (kind) => (..._args) => {
  if (phase === 'instrumentation-probe') probeEvents.push(kind)
  else appendFileSync('/proof/dispatch-attempts', kind + '\n')
  throw new Error('financial fixture blocked ' + kind)
}
const child = require('node:child_process')
for (const key of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) child[key] = deny('process')
for (const name of ['node:http', 'node:https']) {
  const mod = require(name)
  mod.request = deny('http')
  mod.get = deny('http')
}
globalThis.fetch = deny('fetch')
syncBuiltinESMExports()
if (phase === 'instrumentation-probe') {
  // Both CJS and ESM fixtures capture the APIs during module initialization.
  // A captured reference must still be the denying function, not the original.
  const Module = require('node:module').Module
  const captured = new Module('/capture-probe.cjs')
  captured.filename = '/capture-probe.cjs'
  captured._compile("const {spawn}=require('node:child_process'); const {request}=require('node:http'); module.exports={spawn,request}", captured.filename)
  assert.throws(() => captured.exports.spawn('/never-execute'), /blocked process/)
  assert.throws(() => captured.exports.request('http://127.0.0.1/'), /blocked http/)
  const esm = await import('data:text/javascript,' + encodeURIComponent("export {spawn} from 'node:child_process'; export {request} from 'node:https'"))
  assert.throws(() => esm.spawn('/never-execute'), /blocked process/)
  assert.throws(() => esm.request('https://127.0.0.1/'), /blocked http/)
  assert.throws(() => globalThis.fetch('https://127.0.0.1/'), /blocked fetch/)
  assert.deepEqual(probeEvents, ['process','http','process','http','fetch'])
  console.log('capture-at-import-dispatch-denied')
  process.exit(0)
}
const { Queue, Worker } = require('bullmq')
const db = require('@lyrashield/db')
const { PrismaClient } = require('@lyrashield/db/src/generated/prisma')
const { createBoundedPgAdapter } = require('@lyrashield/db/src/pool')
const { buildScanExecutionPlan, SCAN_QUEUE_NAME } = require('@lyrashield/types')
const { processScanJob } = require('./src/jobs/run-scan.job.ts')
assert.equal(process.env.DATABASE_URL, 'postgresql://app_runtime_ci:runtime-ci-only@postgres:5432/lyrashield')
assert.equal(process.env.REDIS_URL, 'redis://redis:6379')
const owner = new PrismaClient({ adapter: createBoundedPgAdapter(process.env.DATABASE_DIRECT_URL) })
const [role] = await db.prisma.$queryRaw`SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`
assert.deepEqual(role, {role:'app_runtime_ci', rolsuper:false, rolbypassrls:false})
const data = { scanId:'fixture-financial-crash', workspaceId:'fixture-financial-workspace', targetId:'fixture-financial-target', goal:'LAUNCH_REVIEW', mode:'QUICK' }
const { scanId, workspaceId, targetId } = data
const connection = { url:process.env.REDIS_URL, maxRetriesPerRequest:null }
const queue = new Queue(SCAN_QUEUE_NAME, {connection})
if (phase === 'init') {
  const uid = 'fixture-financial-owner'
  await owner.user.create({data:{id:uid,name:uid,email:uid+'@example.invalid'}})
  await owner.workspace.create({data:{id:workspaceId,name:workspaceId,slug:workspaceId}})
  await owner.workspaceMember.create({data:{workspaceId,userId:uid,role:'OWNER'}})
  await owner.target.create({data:{id:targetId,workspaceId,name:'fixture',type:'REPO',repoFullName:'fixture/repository',branch:'fixture'}})
  const plan = buildScanExecutionPlan({targetType:'REPO',mode:'QUICK',engineBudgetCeilingUsd:1})
  await owner.scan.create({data:{id:scanId,workspaceId,targetId,goal:data.goal,mode:data.mode,createdById:uid,policyId:null,accountingVersion:2,status:'QUEUED',executionPlan:plan,executionPlanHash:db.computeScanExecutionPlanHash(plan)}})
  await owner.scanCapacityReservation.create({data:{scanId,workspaceId,accountId:uid,userId:uid,state:'WAITING',multiplier:1}})
  await owner.minutePack.create({data:{accountId:uid,workspaceId,provider:'fixture',externalId:uid,minutes:12,remainingMinutes:12}})
  const job = await queue.add('scan',{...data,nonce:randomUUID()},{jobId:scanId,attempts:3,removeOnComplete:false})
  writeFileSync('/proof/identity.json',JSON.stringify({id:job.id, timestamp:job.timestamp, nonce:job.data.nonce}),{flag:'wx'})
} else if (phase === 'original' || phase === 'recover') {
  const original = JSON.parse(readFileSync('/proof/identity.json','utf8'))
  const recover = phase === 'recover'
  const stalls = []
  const worker = new Worker(SCAN_QUEUE_NAME,async (job,token) => {
    assert.equal(job.id,original.id)
    assert.equal(job.timestamp,original.timestamp)
    assert.equal(job.data.nonce,original.nonce)
    assert.equal(await job.getState(),'active')
    const {getRedis} = await import('@lyrashield/integrations')
    assert.equal(await getRedis().get(queue.toKey(job.id+':lock')),token)
    assert.equal(job.attemptsStarted,recover ? 2 : 1)
    if (recover) assert.equal(job.stalledCounter,1)
    // Both deliveries use the real candidate entry point and original BullMQ job.
    const result = await processScanJob(job)
    if (!recover) throw new Error('original worker returned before host killed it at the claim barrier: '+JSON.stringify(result))
    assert.equal(result.errorCategory,'BILLABLE_PHASE_INTERRUPTED')
    assert.equal((await owner.scan.findUniqueOrThrow({where:{id:scanId}})).status,'RUNNING')
    const reservation = await owner.scanCapacityReservation.findUniqueOrThrow({where:{scanId}})
    assert.equal(reservation.state,'RUNNING')
    assert.ok(reservation.fundedMinutes > 0)
    assert.equal(reservation.stoppedAt,null)
    assert.equal(await owner.scanEvent.count({where:{scanId,stage:'billable_boundary'}}),1)
    assert.equal(await owner.scanResultManifest.count({where:{scanId}}),0)
    assert.equal(await owner.usageRecord.count({where:{kind:'agent_minutes'}}),0)
    assert.ok(!existsSync('/proof/dispatch-attempts'))
    writeFileSync('/proof/recovery.json',JSON.stringify({jobId:job.id,timestamp:job.timestamp,nonce:job.data.nonce,attemptsStarted:job.attemptsStarted,stalledCounter:job.stalledCounter,result:result.errorCategory,claims:1,manifests:0,dispatchAttempts:0,reservation:'RUNNING',stoppedAt:null}),{flag:'wx'})
    return result
  },{connection,autorun:false,lockDuration:5000,stalledInterval:500,maxStalledCount:1})
  worker.on('stalled',id=>stalls.push(id))
  await new Promise((resolve,reject)=>{worker.once('completed',resolve);worker.once('failed',(_job,e)=>reject(e));worker.once('error',reject);worker.run().catch(reject)})
  assert.deepEqual(stalls,[scanId])
  await worker.close()
} else throw new Error('unknown financial fixture phase')
await queue.close()
await owner.$disconnect()
process.exit(0)
