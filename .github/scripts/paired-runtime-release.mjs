// Dormant protected release steps. There is deliberately no CLI or environment
// switch. The future workflow owns live infrastructure readers and credentials.
import assert from "node:assert/strict"
import {
  constants,
  lstatSync,
  fstatSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  readFileSync,
} from "node:fs"
import { pairedHold, assertPairedWorkDrained, waitForPairedDrain } from "./paired-runtime-hold.mjs"
import { join } from "node:path"
import {
  pairedReleaseReceipt,
  assertHeldReadiness,
} from "../../ops/monitoring/paired-release-hold.mjs"

const digest = /^sha256:[a-f0-9]{64}$/
const revision = /^[a-z][a-z0-9-]{0,30}--[a-z0-9][a-z0-9-]{0,30}$/
const services = ["relay", "app", "scanner"]
const digestFields = ["workerDigest", "webDigest", "proxyDigest", "priorWorkerDigest"]

// Rebuild only the bounded nonsecret fields, never serialize adapter output.
function identity(input) {
  const { owner, productRevision, engineRevision } = input
  pairedReleaseReceipt(owner, productRevision, engineRevision, input.workerDigest)
  const pair = { owner, productRevision, engineRevision }
  for (const key of digestFields) {
    assert.equal(typeof input[key], "string")
    assert.match(input[key], digest)
    pair[key] = input[key]
  }
  for (const service of services) {
    const desired = input[service]
    assert.match(desired.previous, revision)
    assert.match(desired.candidate, revision)
    assert.equal(desired.previous.split("--")[0], desired.candidate.split("--")[0])
    assert.notEqual(desired.previous, desired.candidate)
    pair[service] = Object.freeze({ previous: desired.previous, candidate: desired.candidate })
  }
  assert.equal(new Set(services.map((s) => pair[s].candidate.split("--")[0])).size, 3)
  return Object.freeze(pair)
}

// Only a runner-owned private directory on persistent protected storage can
// authorize the separate release step. Do not follow a substituted record.
function privateDirectory(dir) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-protected state root or canonical owner beneath it
  const info = lstatSync(dir)
  assert.ok(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0)
}

function verifiedRecord(dir, stage) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private owner directory and constant verified stage
  const fd = openSync(
    join(dir, stage),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const stat = fstatSync(fd)
    assert.ok(
      stat.isFile() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0 &&
        stat.nlink === 1 &&
        stat.size <= 4096
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- verified bounded open descriptor
    return JSON.parse(readFileSync(fd, "utf8"))
  } finally {
    closeSync(fd)
  }
}

function persist(dir, stage, pair) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- exclusive new record in the private release directory
  const fd = openSync(join(dir, stage), "wx", 0o600)
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- exclusive descriptor for this stage
    writeFileSync(fd, JSON.stringify({ version: 1, stage, pair }) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(dir)
}

function syncDirectory(dir) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- synchronizes the verified directory
  const fd = openSync(dir, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function checkpoint(signal) {
  signal?.throwIfAborted()
}

// The protected classifier must read authoritative run identity and qualifications,
// including mode conflicts. Never take capability or ownership from dispatch text.
async function verifyQualification(adapter, pair) {
  const approval = await adapter.readQualifiedRelease()
  assert.equal(approval.mode, "paired")
  assert.equal(approval.qualified, true)
  assert.equal(approval.conflictingMaintenance, false)
  assert.deepEqual(identity(approval.pair), pair)
}

async function verifyWorker(adapter, pair) {
  const w = await adapter.readWorker(pair)
  assert.deepEqual(w, {
    productRevision: pair.productRevision,
    engineRevision: pair.engineRevision,
    digest: pair.workerDigest,
    imageIdMatchesDigest: true,
    healthy: true,
    consumers: 1,
    runRecordV11: "0",
    pendingHttpEvidence: "0",
  })
}

async function verifyRoute(adapter, pair, name, retired = true) {
  const r = await adapter.readServingRoute(name, pair)
  assert.equal(r.revision, pair[name].candidate)
  assert.equal(r.digest, name === "relay" ? pair.proxyDigest : pair.webDigest)
  assert.deepEqual(r.traffic, [{ revision: pair[name].candidate, weight: 100 }])
  if (retired) {
    assert.equal(r.oldRevisionReachable, false)
    assert.equal(r.oldServingReplicas, 0)
    assert.equal(r.otherServingRevisions, 0)
  }
  assert.equal(r.healthy, true)
  assert.ok(Number.isSafeInteger(r.replicas) && r.replicas >= 1)
  if (name === "relay") {
    assert.equal(r.replicas, 1)
    assert.equal(r.ownedGrantRefusalVerified, true)
  }
}

async function verifyFleet(adapter, pair) {
  for (const name of services) await verifyRoute(adapter, pair, name)
  await verifyWorker(adapter, pair)
  await adapter.verifySourceAndConnectionContinuity(pair)
}

async function verifyHeld(adapter, pair, hold) {
  await hold.assert()
  await verifyFleet(adapter, pair)
  await assertPairedWorkDrained(adapter.redis, adapter.db, () => adapter.readPhysicalDrain(pair))
  const { readyCode, readyBody, scansCode, scansBody } = await adapter.readReadiness(pair)
  assertHeldReadiness(readyCode, readyBody, scansCode, scansBody)
  await hold.assert()
}

// Never restore a previous tuple. A verified operator adapter must recheck the
// owner before each containment mutation. A foreign or unavailable latch is
// left to an operator. Even after re-holding, the admission gap remains real.
async function contain(adapter, pair, hold, dir, afterIntent) {
  const state = await hold.state()
  if (afterIntent && state === "absent") {
    persist(dir, "admission-gap", pair)
    await hold.claim()
  } else if (state !== "owned") {
    persist(dir, "ownership-unconfirmed", pair)
    return
  }
  await hold.assert()
  await adapter.containOwnedConsumers(pair)
  await hold.assert()
  persist(dir, "contained", pair)
}

export async function promoteHeldPair(input, root, adapter, signal) {
  const pair = identity(input)
  const hold = pairedHold(adapter.redis, pair)
  privateDirectory(root)
  const dir = join(root, pair.owner)
  await verifyQualification(adapter, pair)
  checkpoint(signal)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated numeric owner underneath a private root
  mkdirSync(dir, { mode: 0o700 }) // no adoption, including a same-run retry
  syncDirectory(root)
  persist(dir, "claim-intent", pair)
  await hold.claim()
  try {
    const held = async (stage, mutate) => {
      checkpoint(signal)
      await hold.assert()
      checkpoint(signal)
      persist(dir, stage, pair)
      await mutate()
      checkpoint(signal)
      await hold.assert()
    }
    await hold.assert()
    const { readyCode, readyBody, scansCode, scansBody } = await adapter.readReadiness(pair)
    assertHeldReadiness(readyCode, readyBody, scansCode, scansBody)
    await waitForPairedDrain(
      pair,
      adapter.redis,
      adapter.db,
      () => adapter.readPhysicalDrain(pair),
      signal
    )
    await held("stop-legacy", () => adapter.stopLegacyConsumers(pair))
    await adapter.verifyStoppedLegacy(pair)
    await assertPairedWorkDrained(adapter.redis, adapter.db, () => adapter.readPhysicalDrain(pair))
    for (const name of services) {
      await held("stage-" + name, () => adapter.stageAtZeroTraffic(name, pair))
      await adapter.verifyZeroTrafficCandidate(name, pair)
    }
    const replaceRoute = async (name) => {
      await held("route-" + name, () => adapter.promoteNamedRoute(name, pair))
      await verifyRoute(adapter, pair, name, false)
      await held("retire-" + name, () => adapter.retirePreviousRevision(name, pair))
      await verifyRoute(adapter, pair, name)
    }
    await replaceRoute("relay")
    await held("install-worker", () => adapter.promoteStoppedWorker(pair))
    await verifyWorker(adapter, pair)
    for (const name of ["app", "scanner"]) await replaceRoute(name)
    await verifyHeld(adapter, pair, hold)
    checkpoint(signal)
    persist(dir, "pair-held-verified", pair)
  } catch (error) {
    await contain(adapter, pair, hold, dir, false)
    throw error
  }
}

// Separate step. A lost DEL acknowledgement or post-release failure must not
// replay DEL; exclusive intent consumes the record before sending it.
export async function releaseVerifiedPair(input, root, adapter, signal) {
  const pair = identity(input)
  const hold = pairedHold(adapter.redis, pair)
  privateDirectory(root)
  const dir = join(root, pair.owner)
  const stage = "pair-held-verified"
  privateDirectory(dir)
  assert.deepEqual(verifiedRecord(dir, stage), { version: 1, stage, pair })
  persist(dir, "verification-started", pair)
  let releaseStarted = false
  try {
    await verifyQualification(adapter, pair)
    await verifyHeld(adapter, pair, hold)
    checkpoint(signal)
    persist(dir, "release-intent", pair)
    releaseStarted = true
    await hold.release()
    persist(dir, "release-acknowledged", pair)
    checkpoint(signal)
    assert.equal(await hold.state(), "absent")
    await verifyFleet(adapter, pair)
    const { readyCode, readyBody, scansCode, scansBody } = await adapter.readReadiness(pair)
    const ready = JSON.parse(readyBody),
      scans = JSON.parse(scansBody)
    assert.equal(readyCode, "200")
    assert.equal(ready.status, "ready")
    assert.equal(ready.checks?.database, true)
    assert.equal(ready.checks?.redis, true)
    assert.equal(scansCode, "200")
    assert.equal(scans.status, "ready")
    assert.equal(scans.checks?.worker, true)
    assert.equal(await hold.state(), "absent")
    checkpoint(signal)
    persist(dir, "release-verified", pair)
  } catch (error) {
    await contain(adapter, pair, hold, dir, releaseStarted)
    throw error
  }
}
