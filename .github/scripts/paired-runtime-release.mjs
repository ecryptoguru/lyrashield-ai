import {
  verifyPrivateProjection,
  armedAuthority,
  recoveryAuthority,
  rebindReceipt,
  observeRebind,
  releaseWithinLease,
  requireProof,
} from "./paired-runtime-authority.mjs"
// Dormant protected release steps. There is deliberately no CLI or environment
// switch. The future workflow owns live infrastructure readers and credentials.
import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"
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
const digestFields = [
  "workerDigest",
  "webDigest",
  "proxyDigest",
  "priorWorkerDigest",
  "sandboxDigest",
]

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

function persist(dir, stage, pair, workerFailure, intent) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- exclusive new record in the private release directory
  const fd = openSync(join(dir, stage), "wx", 0o600)
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- exclusive descriptor for this stage
    writeFileSync(fd, JSON.stringify({ version: 1, stage, pair, workerFailure, intent }) + "\n")
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

// Only forward the local wrapper's bounded metadata into the private stage
// record. Raw stderr may contain arbitrary cloud diagnostics or credentials.
function workerFailureMetadata(error) {
  const stderr = error?.stderr
  if (!(typeof stderr === "string" || Buffer.isBuffer(stderr)) || stderr.length > 2048)
    return { kind: "unknown" }
  const lines = stderr.toString().trimEnd().split(/\r?\n/)
  const guest =
    /^Paired VM completion unverified \(guest stage (prepare|drain|promote|cleanup), exit ([1-9][0-9]{0,2})\)$/.exec(
      lines.at(-1)
    )
  if (guest && Number(guest[2]) <= 255)
    return { kind: "guest", stage: guest[1], exit: Number(guest[2]) }
  const transport = lines
    .map((line) => /^Paired VM transport exit ([1-9][0-9]{0,2}); guest status unknown$/.exec(line))
    .find(Boolean)
  if (transport && Number(transport[1]) <= 255)
    return {
      kind: "transport",
      exit: Number(transport[1]),
      category: lines.includes("Paired VM transport: timeout")
        ? "timeout"
        : lines.includes("Paired VM transport: busy")
          ? "busy"
          : "unknown",
    }
  return { kind: "unknown" }
}

async function verifyWorker(adapter, pair, selectorPresent = false) {
  const w = await adapter.readWorker(pair)
  const expected = {
    productRevision: pair.productRevision,
    engineRevision: pair.engineRevision,
    digest: pair.workerDigest,
    imageIdMatchesDigest: true,
    healthy: true,
    consumers: 1,
    runRecordV11: "0",
    pendingHttpEvidence: "0",
    sandboxDigest: pair.sandboxDigest,
    sandboxImageMatchesRuntime: true,
    canarySelectorPresent: selectorPresent,
  }
  // Never echo unexpected fields or the selector/value in an assertion diff.
  assert.ok(isDeepStrictEqual(w, expected), "worker identity or writer-off proof mismatch")
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

async function verifyFleet(adapter, pair, selectorPresent = false) {
  for (const name of services) await verifyRoute(adapter, pair, name)
  await verifyWorker(adapter, pair, selectorPresent)
  await adapter.verifySourceAndConnectionContinuity(pair)
}

async function verifyHeld(adapter, pair, hold, selectorPresent = false) {
  await hold.assert()
  await verifyFleet(adapter, pair, selectorPresent)
  await assertPairedWorkDrained(adapter.redis, adapter.db, () => adapter.readPhysicalDrain(pair))
  const { readyCode, readyBody, scansCode, scansBody } = await adapter.readReadiness(pair)
  assertHeldReadiness(readyCode, readyBody, scansCode, scansBody)
  await hold.assert()
}

// Never restore a previous tuple. A verified operator adapter must recheck the
// owner before each containment mutation. A foreign or unavailable latch is
// left to an operator. Even after re-holding, the admission gap remains real.
async function contain(adapter, pair, hold, dir) {
  const observe = () => hold.state().catch(() => "unknown")
  let state = await observe()
  if (state === "absent") {
    persist(dir, "admission-gap", pair)
    // A racing foreign claim must win. Re-read after an ambiguous NX
    // acknowledgement before touching either fleet or admission.
    try {
      await hold.claim()
      state = "owned"
    } catch {
      state = await observe()
    }
  }
  if (state !== "owned") {
    persist(dir, "ownership-unconfirmed", pair)
    return
  }
  try {
    await hold.assert()
    await adapter.containOwnedConsumers(pair)
    await hold.assert()
  } catch (error) {
    persist(dir, "containment-unconfirmed", pair)
    throw error
  }
  persist(dir, "contained", pair)
}

async function mutateHeld(dir, pair, hold, signal, stage, mutate) {
  checkpoint(signal)
  await hold.assert()
  checkpoint(signal)
  persist(dir, stage, pair)
  await mutate()
  checkpoint(signal)
  await hold.assert()
}

async function installQuiesced(pair, adapter, hold, dir, signal, stageRevision) {
  const held = (stage, mutate) => mutateHeld(dir, pair, hold, signal, stage, mutate)
  for (const name of services) {
    await held("stage-" + name, () => stageRevision(name, pair))
    await adapter.verifyZeroTrafficCandidate(name, pair)
  }
  const replaceRoute = async (name) => {
    await held("route-" + name, () => adapter.promoteNamedRoute(name, pair))
    await verifyRoute(adapter, pair, name, false)
    await held("retire-" + name, () => adapter.retirePreviousRevision(name, pair))
    await verifyRoute(adapter, pair, name)
  }
  await replaceRoute("relay")
  await held("install-worker", async () => {
    try {
      await adapter.promoteStoppedWorker(pair)
    } catch (error) {
      persist(dir, "worker-promotion-failed", pair, workerFailureMetadata(error))
      throw new Error("Paired worker promotion failed; inspect the protected stage record")
    }
  })
  await verifyWorker(adapter, pair)
  for (const name of ["app", "scanner"]) await replaceRoute(name)
  await verifyHeld(adapter, pair, hold)
  checkpoint(signal)
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
    await mutateHeld(dir, pair, hold, signal, "stop-legacy", () =>
      adapter.stopLegacyConsumers(pair, pair.priorWorkerDigest)
    )
    await adapter.verifyStoppedLegacy(pair)
    await assertPairedWorkDrained(adapter.redis, adapter.db, () => adapter.readPhysicalDrain(pair))
    await installQuiesced(pair, adapter, hold, dir, signal, (name, p) =>
      adapter.stageAtZeroTraffic(name, p)
    )
    persist(dir, "pair-held-verified", pair)
  } catch (error) {
    await contain(adapter, pair, hold, dir)
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
  try {
    await verifyQualification(adapter, pair)
    await verifyHeld(adapter, pair, hold)
    checkpoint(signal)
    persist(dir, "release-intent", pair)
    await hold.release()
    persist(dir, "release-acknowledged", pair)
    checkpoint(signal)
    assert.equal(await hold.state(), "absent")
    await verifyFleet(adapter, pair)
    await verifyOpen(adapter, pair)
    assert.equal(await hold.state(), "absent")
    checkpoint(signal)
    persist(dir, "release-verified", pair)
  } catch (error) {
    await contain(adapter, pair, hold, dir)
    throw error
  }
}

async function verifyOpen(adapter, pair) {
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
}

// The approval reference is a content digest. Only the protected store and
// authenticated original-owner/explicit takeover records can authorize it.
function startProtected(root, pair, acquisition, id) {
  privateDirectory(root)
  const dir = join(root, pair.owner)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated owner under private protected root
  mkdirSync(dir, { mode: 0o700 })
  syncDirectory(root)
  // An arm and a recovery (or two takeover owners) cannot both mutate under one acquisition.
  intentStage(root, "acquisition-use-" + acquisition, pair, id)
  return dir
}
function matchStage(dir, stage, pair, id) {
  privateDirectory(dir)
  requireProof(
    isDeepStrictEqual(verifiedRecord(dir, stage), { version: 1, stage, pair, intent: id })
  )
}
function intentStage(dir, stage, pair, id) {
  persist(dir, stage, pair, undefined, id)
}
async function stoppedOrigin(adapter, source, acq) {
  await adapter.verifyStoppedLegacy(source, source.workerDigest)
  requireProof((await adapter.proveStoppedOrigin(source, acq.continuity)) === true)
  await assertPairedWorkDrained(adapter.redis, adapter.db, () => adapter.readPhysicalDrain(source))
}

async function beforeRebind(id, adapter, { source, acq, r }, signal) {
  const prior = pairedHold(adapter.redis, source)
  await prior.assert()
  requireProof(
    (await adapter.proveOriginalOperationAccounted(r.sourceAcquisition, r.canaryEvidence)) === true
  )
  requireProof((await adapter.proveSelectorFileAbsent()) === true)
  await stoppedOrigin(adapter, source, acq)
  for (const name of services) await verifyRoute(adapter, source, name)
  await adapter.verifySourceAndConnectionContinuity(source)
  requireProof((await adapter.verifyAcquisitionContinuity(r.sourceAcquisition)) === true)
  await recoveryAuthority(adapter, id, identity)
  await prior.assert()
  checkpoint(signal)
}

// Strictly after the source hold's actual acquisition. This entry never
// claims an absent key and never submits a canary request.
export async function restoreQualifiedPair(id, root, adapter, signal) {
  const a = await recoveryAuthority(adapter, id, identity),
    { source, pair, acq, r } = a
  const prior = pairedHold(adapter.redis, source)
  await prior.assert()
  requireProof((await adapter.verifyAcquisitionContinuity(r.sourceAcquisition)) === true)
  await verifyFleet(adapter, source, acq.selectorHash !== null)
  const dir = startProtected(root, pair, r.sourceAcquisition, id)
  intentStage(dir, "restore-authorized", pair, id)
  try {
    await waitForPairedDrain(
      source,
      adapter.redis,
      adapter.db,
      () => adapter.readPhysicalDrain(source),
      signal
    )
    requireProof(
      (await adapter.proveOriginalOperationAccounted(r.sourceAcquisition, r.canaryEvidence)) ===
        true
    )
    await mutateHeld(dir, source, prior, signal, "stop-source", () =>
      adapter.stopLegacyConsumers(source, source.workerDigest)
    )
    await stoppedOrigin(adapter, source, acq)
    if (acq.selectorHash !== null) {
      requireProof(
        (await adapter.proveOriginalOperationAccounted(r.sourceAcquisition, r.canaryEvidence)) ===
          true
      )
      await mutateHeld(dir, source, prior, signal, "clear-accounted-selector", () =>
        adapter.clearMatchingSelector(acq.selectorHash, source)
      )
    }
    await beforeRebind(id, adapter, a, signal)
  } catch (error) {
    await contain(adapter, source, prior, dir)
    throw error
  }
  intentStage(dir, "rebind-intent", pair, id)
  return commitRebind(id, root, adapter, signal, source, pair)
}

async function commitRebind(id, root, adapter, signal, source, pair) {
  try {
    await rebindReceipt(adapter.redis, source, pair)
  } catch {
    throw new Error("Rebind unconfirmed; inspect the same protected intent")
  }
  return finishReboundPair(id, root, adapter, signal)
}

export async function inspectReboundPair(id, root, adapter) {
  const { source, pair, r } = await recoveryAuthority(adapter, id, identity)
  privateDirectory(root)
  matchStage(root, "acquisition-use-" + r.sourceAcquisition, pair, id)
  matchStage(join(root, pair.owner), "rebind-intent", pair, id)
  return observeRebind(adapter.redis, source, pair).catch(() => "unknown")
}

// If the first command did not apply, an operator may authorize one retry
// of exactly that journaled intent after proving the source remained held.
export async function retryUnappliedRebind(id, root, adapter, signal) {
  const a = await recoveryAuthority(adapter, id, identity)
  privateDirectory(root)
  const dir = join(root, a.pair.owner)
  matchStage(root, "acquisition-use-" + a.r.sourceAcquisition, a.pair, id)
  matchStage(dir, "rebind-intent", a.pair, id)
  requireProof((await observeRebind(adapter.redis, a.source, a.pair)) === "source")
  requireProof((await adapter.authorizeUnappliedRetry(id)) === true)
  await beforeRebind(id, adapter, a, signal)
  intentStage(dir, "rebind-retry-intent", a.pair, id)
  return commitRebind(id, root, adapter, signal, a.source, a.pair)
}

// Explicit same-intent continuation after lost ACK. Only the destination
// receipt can proceed; never replay CAS or a started installation.
export async function finishReboundPair(id, root, adapter, signal) {
  const { source, pair, acq, r } = await recoveryAuthority(adapter, id, identity)
  privateDirectory(root)
  const dir = join(root, pair.owner),
    hold = pairedHold(adapter.redis, pair)
  matchStage(root, "acquisition-use-" + r.sourceAcquisition, pair, id)
  matchStage(dir, "rebind-intent", pair, id)
  requireProof((await observeRebind(adapter.redis, source, pair)) === "destination")
  await hold.assert()
  requireProof((await adapter.proveReboundContinuity(id)) === true)
  await stoppedOrigin(adapter, source, acq)
  requireProof((await adapter.proveSelectorFileAbsent()) === true)
  checkpoint(signal)
  intentStage(dir, "restore-install-started", pair, id)
  try {
    await installQuiesced(pair, adapter, hold, dir, signal, (name, p) =>
      adapter.reactivateArchivedRevision(name, p)
    )
    await evidenceReads(adapter, pair, r)
    intentStage(dir, "restore-held-verified", pair, id)
  } catch (error) {
    await contain(adapter, pair, hold, dir)
    throw error
  }
}

async function evidenceReads(adapter, pair, r) {
  const reads = await adapter.readRestoredEvidence(pair, r.baselineEvidence, r.canaryEvidence)
  requireProof(
    isDeepStrictEqual(reads, {
      baselineEvidence: r.baselineEvidence,
      canaryEvidence: r.canaryEvidence,
    })
  )
}

export async function releaseRestoredPair(id, root, adapter, signal) {
  const { pair, r } = await recoveryAuthority(adapter, id, identity)
  privateDirectory(root)
  const dir = join(root, pair.owner),
    hold = pairedHold(adapter.redis, pair)
  matchStage(root, "acquisition-use-" + r.sourceAcquisition, pair, id)
  matchStage(dir, "restore-held-verified", pair, id)
  intentStage(dir, "restore-release-started", pair, id)
  try {
    await verifyHeld(adapter, pair, hold)
    await evidenceReads(adapter, pair, r)
    await recoveryAuthority(adapter, id, identity)
    requireProof((await adapter.proveReboundContinuity(id)) === true)
    await hold.assert()
    checkpoint(signal)
    intentStage(dir, "release-intent", pair, id)
    await hold.release()
    intentStage(dir, "release-acknowledged", pair, id)
    await verifyFleet(adapter, pair)
    await verifyOpen(adapter, pair)
    await evidenceReads(adapter, pair, r)
    requireProof((await hold.state()) === "absent")
    checkpoint(signal)
    intentStage(dir, "restored-release-verified", pair, id)
  } catch (error) {
    await contain(adapter, pair, hold, dir)
    throw error
  }
}

async function armedReadback(adapter, pair, r) {
  await verifyPrivateProjection(() => adapter.readArmedSelectorProof(pair, r.selectorHash), {
    preparedFileHash: r.selectorHash,
    runningFileHash: r.selectorHash,
    inputHash: r.inputHash,
    sandboxDigest: pair.sandboxDigest,
    capUsd: r.capUsd,
    issuedAtMs: r.issuedAtMs,
    expiresAtMs: r.expiresAtMs,
    protectedFile: true,
    clockVerified: true,
    requestUnused: true,
  })
}

// Operator installed the one prepared sibling and recreated B under a fresh
// scoped B hold. The release neither installs a selector nor creates a job.
export async function releaseArmedCanary(id, root, adapter, signal) {
  const { pair, r } = await armedAuthority(adapter, id, identity)
  const hold = pairedHold(adapter.redis, pair)
  await hold.assert()
  const dir = startProtected(root, pair, r.sourceAcquisition, id)
  intentStage(dir, "arm-verification-started", pair, id)
  try {
    requireProof((await adapter.verifyAcquisitionContinuity(r.sourceAcquisition)) === true)
    await verifyHeld(adapter, pair, hold, true)
    await armedReadback(adapter, pair, r)
    await armedAuthority(adapter, id, identity)
    requireProof((await adapter.verifyAcquisitionContinuity(r.sourceAcquisition)) === true)
    await hold.assert()
    checkpoint(signal)
    intentStage(dir, "arm-release-intent", pair, id)
    await releaseWithinLease(adapter.redis, pair, r)
    intentStage(dir, "arm-release-acknowledged", pair, id)
    requireProof((await hold.state()) === "absent")
    await verifyFleet(adapter, pair, true)
    await verifyOpen(adapter, pair)
    await armedReadback(adapter, pair, r)
    requireProof((await hold.state()) === "absent" && Date.now() + 30000 < r.expiresAtMs)
    checkpoint(signal)
    intentStage(dir, "arm-released-verified", pair, id)
  } catch (error) {
    await contain(adapter, pair, hold, dir)
    throw error
  }
}
