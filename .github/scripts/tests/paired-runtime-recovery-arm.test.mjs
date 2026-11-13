import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { hashRecord, readSelectorBinding } from "../paired-runtime-authority.mjs"
import {
  restoreQualifiedPair,
  finishReboundPair,
  inspectReboundPair,
  retryUnappliedRebind,
  releaseRestoredPair,
  releaseArmedCanary,
  releaseVerifiedPair,
} from "../paired-runtime-release.mjs"
import { pairedReleaseReceipt } from "../../../ops/monitoring/paired-release-hold.mjs"
import {
  qualifiedFleetSchema,
  qualificationControlPlaneFields,
} from "../paired-runtime-qualification.mjs"

const D = (n) => "sha256:" + hashRecord(n),
  H = (n) => hashRecord(n)
const names = ["relay", "app", "scanner"]
function pair(owner, key) {
  const p = {
    owner,
    productRevision: (key === "a" ? "a" : "b").repeat(40),
    engineRevision: "f".repeat(40),
    workerDigest: D("worker" + key),
    webDigest: D("web" + key),
    proxyDigest: D("proxy" + key),
    priorWorkerDigest: D("older"),
    sandboxDigest: D("sandbox" + key),
  }
  for (const name of names) p[name] = { previous: name + "--old", candidate: name + "--" + key }
  return p
}
const receipt = (p) =>
  pairedReleaseReceipt(p.owner, p.productRevision, p.engineRevision, p.workerDigest)

function fixture(t, edits = {}) {
  const root = mkdtempSync(join(tmpdir(), "paired-restore-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const A = pair("11:1", "a"),
    B = pair("12:1", "b")
  B.priorWorkerDigest = A.workerDigest
  for (const n of names) B[n].previous = A[n].candidate
  Object.assign(A, edits.A)
  Object.assign(B, edits.B)
  const src = { ...B, owner: "13:1" },
    target = { ...A, owner: "14:1", priorWorkerDigest: B.workerDigest }
  for (const n of names) target[n] = { previous: B[n].candidate, candidate: A[n].candidate }
  const records = new Map(),
    add = (v) => {
      const id = H(v)
      records.set(id, JSON.stringify(v))
      return id
    }
  const archive = (p) =>
    add({
      kind: "qualified-fleet",
      schema: qualifiedFleetSchema,
      pair: p,
      controlPlane: Object.fromEntries(qualificationControlPlaneFields.map((key) => [key, D(key)])),
      releaseProof: H("release" + p.productRevision),
      sandboxProof: H("sandbox" + p.sandboxDigest),
      financialProof: H("money" + p.productRevision),
      readerProof: H("reader" + p.productRevision),
      connectionProof: H("authority"),
    })
  const a = archive(A),
    b = archive(B),
    nonce = H("private recovery nonce"),
    selector = H("exact canonical bytes including uuid")
  const acq = add({
    kind: "hold-acquisition",
    owner: src.owner,
    fleet: b,
    continuity: H("exclusive-acquisition"),
    selectorHash: selector,
  })
  const reverse = H(target),
    h = add({
      kind: "handoff",
      authorization: "original-owner",
      sourceOwner: src.owner,
      newOwner: target.owner,
      sourceAcquisition: acq,
      destinationArchive: a,
      reversePlan: reverse,
      nonceHash: H(nonce),
      ...edits.handoff,
    })
  const r = {
    kind: "restore",
    nonce,
    owner: target.owner,
    sourceAcquisition: acq,
    destinationArchive: a,
    reversePlan: reverse,
    handoff: h,
    baselineEvidence: H("baseline read"),
    canaryEvidence: H("actual canary read"),
    ...edits.restore,
  }
  const restore = add(r)
  const armAcq = add({
    kind: "hold-acquisition",
    owner: src.owner,
    fleet: b,
    continuity: H("new exclusive arm acquisition"),
    selectorHash: null,
  })
  const now = Date.now(),
    grant = {
      kind: "arm",
      nonce: H("arm nonce"),
      owner: src.owner,
      sourceAcquisition: armAcq,
      selectorHash: selector,
      inputHash: H("operation input"),
      issuedAtMs: now - 1000,
      expiresAtMs: now + 300000,
      capUsd: 1,
      ...edits.arm,
    }
  const arm = add(grant)
  const f = {
    root,
    A,
    B,
    src,
    target,
    restore,
    arm,
    grant,
    records,
    selector,
    owner: target.owner,
    state: receipt(src),
    hasSelector: true,
    log: [],
  }
  const event = (n) => {
    f.log.push(n)
    if (f.fail === n) throw new Error("fault " + n)
  }
  const redis = {
    llen: async () => 0,
    zcard: async () => 0,
    set: async (k, v) => {
      if (f.state !== null) return null
      f.state = v
      return "OK"
    },
    eval: async (lua, count, key, one, two, three) => {
      if (lua.includes('"XX"')) {
        event("rebind")
        if (f.undelivered) throw new Error("unsubmitted")
        if (f.state !== one) return 0
        f.state = two
        if (f.lostAck) throw new Error("lost ACK")
        return 1
      }
      if (lua.includes('"destination"'))
        return f.state === null
          ? "absent"
          : f.state === one
            ? "source"
            : f.state === two
              ? "destination"
              : "foreign"
      if (lua.includes('redis.call("TIME")')) {
        event("arm-del")
        if (f.state !== one || Date.now() < two || Date.now() + 30000 >= three) return 0
        f.state = null
        if (f.lostArm) throw new Error("lost ACK")
        return 1
      }
      if (lua.includes('return "absent"'))
        return f.state === null ? "absent" : f.state === one ? "owned" : "foreign"
      if (one === "assert") return f.state === two ? 1 : 0
      if (one === "release" && f.state === two) {
        event("off-del")
        f.state = null
        return 1
      }
      throw new Error("unexpected redis operation")
    },
  }
  const adapter = {
    redis,
    db: { query: async () => ({ rows: [{ drained: true }] }) },
    readPhysicalDrain: async () => "V26_EXECUTION_DRAIN_VERIFIED",
    readAuthenticatedOwner: async () => f.owner,
    readProtectedRecord: async (kind, id) => records.get(id),
    verifyQualifiedArchive: async () => !f.badArchive,
    verifyAcquisitionContinuity: async () => !f.gap,
    proveReboundContinuity: async () => !f.gap,
    verifyRecoveryHandoff: async () => !f.badHandoff,
    verifyArmAuthorization: async () => !f.badArm,
    proveOriginalOperationAccounted: async () => !f.liveJob,
    proveStoppedOrigin: async () => !f.originDrift,
    verifyStoppedLegacy: async () => {
      event("stopped")
    },
    stopLegacyConsumers: async () => event("stop"),
    clearMatchingSelector: async (hash) => {
      assert.equal(hash, selector)
      event("clear")
      f.hasSelector = false
    },
    proveSelectorFileAbsent: async () => !f.hasSelector,
    verifySourceAndConnectionContinuity: async () => event("authority"),
    reactivateArchivedRevision: async (name) => event("activate-" + name),
    verifyZeroTrafficCandidate: async () => event("zero"),
    promoteNamedRoute: async (name) => event("move-" + name),
    retirePreviousRevision: async (name) => event("retire-" + name),
    promoteStoppedWorker: async () => event("worker"),
    containOwnedConsumers: async () => event("contain"),
    readWorker: async (p) => ({
      productRevision: p.productRevision,
      engineRevision: p.engineRevision,
      digest: p.workerDigest,
      imageIdMatchesDigest: true,
      healthy: true,
      consumers: 1,
      runRecordV11: "0",
      pendingHttpEvidence: "0",
      sandboxDigest: p.sandboxDigest,
      sandboxImageMatchesRuntime: true,
      canarySelectorPresent: f.hasSelector,
      ...f.drift,
    }),
    readServingRoute: async (n, p) => ({
      revision: p[n].candidate,
      digest: n === "relay" ? p.proxyDigest : p.webDigest,
      traffic: [{ revision: p[n].candidate, weight: 100 }],
      oldRevisionReachable: false,
      oldServingReplicas: 0,
      otherServingRevisions: 0,
      healthy: true,
      replicas: 1,
      ownedGrantRefusalVerified: true,
    }),
    readReadiness: async () => ({
      readyCode: "200",
      readyBody: '{"status":"ready","checks":{"database":true,"redis":true}}',
      scansCode: f.state === null ? "200" : "503",
      scansBody: JSON.stringify({
        status: f.state === null ? "ready" : "not_ready",
        checks: { worker: f.state === null },
      }),
    }),
    readRestoredEvidence: async (p, baselineEvidence, canaryEvidence) => {
      event("reads")
      return { baselineEvidence, canaryEvidence: f.badRead ? H("wrong") : canaryEvidence }
    },
    readArmedSelectorProof: async () => ({
      preparedFileHash: selector,
      runningFileHash: selector,
      inputHash: grant.inputHash,
      sandboxDigest: src.sandboxDigest,
      capUsd: grant.capUsd,
      issuedAtMs: grant.issuedAtMs,
      expiresAtMs: grant.expiresAtMs,
      protectedFile: true,
      clockVerified: true,
      requestUnused: true,
      ...f.selectorDrift,
    }),
  }
  return Object.assign(f, {
    adapter,
    doRestore: () => restoreQualifiedPair(restore, root, adapter),
    finish: () => finishReboundPair(restore, root, adapter),
    inspect: () => inspectReboundPair(restore, root, adapter),
    release: () => releaseRestoredPair(restore, root, adapter),
    doArm: () => {
      f.owner = src.owner
      return releaseArmedCanary(arm, root, adapter)
    },
  })
}

test("restore actual A tuples via continuous CAS; both reads gate its distinct release", async (t) => {
  const f = fixture(t)
  await f.doRestore()
  assert.equal(f.state, receipt(f.target))
  assert.equal(f.log.filter((n) => n === "rebind").length, 1)
  assert.ok(
    f.log.indexOf("clear") < f.log.indexOf("rebind") &&
      f.log.indexOf("rebind") < f.log.indexOf("move-relay")
  )
  await assert.rejects(releaseVerifiedPair(f.target, f.root, f.adapter), { code: "ENOENT" })
  await f.release()
  assert.equal(f.state, null)
  assert.equal(f.log.filter((n) => n === "reads").length, 3)
  await assert.rejects(f.release(), { code: "EEXIST" })
})
test("lost ACK continues only same consumed intent after positive destination proof", async (t) => {
  const f = fixture(t)
  f.lostAck = true
  await assert.rejects(f.doRestore(), /unconfirmed/)
  assert.equal(await f.inspect(), "destination")
  f.owner = "99:1"
  await assert.rejects(f.finish())
  f.owner = f.target.owner
  await f.finish()
  assert.equal(f.log.filter((n) => n === "rebind").length, 1)
  await assert.rejects(f.finish(), { code: "EEXIST" })
})
for (const state of ["source", "foreign", "absent"])
  test("unconfirmed rebind: " + state, async (t) => {
    const f = fixture(t)
    f.lostAck = true
    await assert.rejects(f.doRestore())
    f.state = state === "source" ? receipt(f.src) : state === "foreign" ? "foreign" : null
    assert.equal(await f.inspect(), state)
    await assert.rejects(f.finish())
    assert.ok(!f.log.includes("worker"))
  })
for (const [key, val] of [
  ["liveJob", true],
  ["gap", true],
  ["originDrift", true],
  ["badArchive", true],
  ["badHandoff", true],
  ["drift", { sandboxDigest: D("retired") }],
]) {
  test("source prerequisite " + key, async (t) => {
    const f = fixture(t)
    f[key] = val
    await assert.rejects(f.doRestore())
    assert.ok(!f.log.includes("rebind"))
    assert.equal(f.state, receipt(f.src))
  })
}
for (const edit of [
  { B: { priorWorkerDigest: D("unrelated predecessor") } },
  { handoff: { authorization: "auto" } },
  { handoff: { sourceOwner: "15:1" } },
  { restore: { reversePlan: H("forged") } },
  { A: { engineRevision: "3001517530300ca5f602536bfadcbd3c95ad3039" } },
  { A: { productRevision: "b03f0bbe2b42f3a49e24e103655187372ba0a5f6" } },
]) {
  test("reject substituted record " + JSON.stringify(edit), async (t) => {
    const f = fixture(t, edit)
    await assert.rejects(f.doRestore())
    assert.deepEqual(f.log, [])
  })
}
test("failed relay activation and unreadable old/new evidence hold A", async (t) => {
  const f = fixture(t)
  f.fail = "activate-relay"
  await assert.rejects(f.doRestore())
  assert.ok(f.log.includes("contain"))
  assert.equal(f.state, receipt(f.target))
  assert.ok(!f.log.includes("worker"))
  await assert.rejects(f.release())
  const g = fixture(t)
  await g.doRestore()
  g.badRead = true
  await assert.rejects(g.release())
  assert.equal(g.state, receipt(g.target))
  assert.ok(!g.log.includes("off-del"))
})
test("armed release verifies exact scoped selector; records contain no nonce, UUID or raw file", async (t) => {
  const f = fixture(t)
  await f.doArm()
  assert.equal(f.state, null)
  await assert.rejects(f.doArm())
  const dir = join(f.root, f.src.owner)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private test-owned per-owner directory
  for (const stage of readdirSync(dir)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- files from that private directory
    const row = JSON.parse(readFileSync(join(dir, stage)))
    assert.deepEqual(row, { version: 1, stage, pair: f.src, intent: f.arm })
  }
})
for (const delta of [
  { runningFileHash: H("other uuid same input") },
  { sandboxDigest: D("retired") },
  { capUsd: 0.5 },
  { requestUnused: false },
  { clockVerified: false },
  { protectedFile: false },
]) {
  test("arm refusal " + Object.keys(delta)[0], async (t) => {
    const f = fixture(t)
    f.selectorDrift = delta
    await assert.rejects(f.doArm())
    assert.ok(!f.log.includes("arm-del"))
    assert.equal(f.state, receipt(f.src))
  })
}
test("expired selector and lost release response never cause a second release", async (t) => {
  const f = fixture(t, {
    arm: { issuedAtMs: Date.now() - 200000, expiresAtMs: Date.now() - 10000 },
  })
  await assert.rejects(f.doArm())
  assert.equal(f.state, receipt(f.src))
  const g = fixture(t)
  g.lostArm = true
  await assert.rejects(g.doArm())
  await assert.rejects(g.doArm())
  assert.equal(g.log.filter((n) => n === "arm-del").length, 1)
  assert.equal(g.state, receipt(g.src))
})

test("actual private selector bytes bind UUID even with unchanged canonical operation hash", (t) => {
  const f = fixture(t),
    p = f.src
  const value = {
    version: 1,
    workspaceId: "ws",
    targetId: "target",
    principalId: "private-account",
    requestId: "00000000-0000-4000-8000-000000000001",
    principalType: "BROWSER_SESSION",
    goal: "LAUNCH_REVIEW",
    mode: "QUICK",
    inputHash: f.grant.inputHash,
    productRevision: p.productRevision,
    engineRevision: p.engineRevision,
    workerImageDigest: p.workerDigest,
    sandboxImageDigest: p.sandboxDigest,
    issuedAtMs: f.grant.issuedAtMs,
    expiresAtMs: f.grant.expiresAtMs,
    capUsd: 1,
  }
  const render = (s) => {
    const encoded = Buffer.from(JSON.stringify(s)).toString("base64url")
    return [Buffer.from("LYRASHIELD_EVIDENCE_WRITER_CANARY=" + encoded + "\n"), encoded]
  }
  const [file, live] = render(value),
    binding = readSelectorBinding(p, file, live)
  const [otherFile, other] = render({ ...value, requestId: "00000000-0000-4000-8000-000000000002" })
  assert.throws(() => readSelectorBinding(p, file, other), /proof mismatch/)
  const alternate = readSelectorBinding(p, otherFile, other)
  assert.equal(binding.inputHash, alternate.inputHash)
  assert.notEqual(binding.preparedFileHash, alternate.preparedFileHash)
  assert.ok(
    !JSON.stringify(binding).includes(value.principalId) &&
      !JSON.stringify(binding).includes(value.requestId)
  )
  assert.throws(
    () => readSelectorBinding({ ...p, sandboxDigest: D("wrong") }, file, live),
    /proof mismatch/
  )
})
test("unauthorized arm, used source acquisition and foreign latch cannot release", async (t) => {
  for (const key of ["badArm", "gap", "foreign"]) {
    const f = fixture(t)
    if (key === "foreign") f.state = "foreign"
    else f[key] = true
    await assert.rejects(f.doArm())
    assert.ok(!f.log.includes("arm-del"))
  }
})
test("explicit protected takeover can restore, ordinary approval cannot substitute", async (t) => {
  const f = fixture(t, { handoff: { authorization: "approved-takeover" } })
  await f.doRestore()
  assert.equal(f.state, receipt(f.target))
})

test("one explicit retry after an unapplied CAS requires original intent and still-quiescent source", async (t) => {
  const f = fixture(t)
  f.undelivered = true
  await assert.rejects(f.doRestore(), /unconfirmed/)
  assert.equal(await f.inspect(), "source")
  f.adapter.authorizeUnappliedRetry = async () => false
  await assert.rejects(retryUnappliedRebind(f.restore, f.root, f.adapter))
  f.undelivered = false
  f.adapter.authorizeUnappliedRetry = async () => true
  await retryUnappliedRebind(f.restore, f.root, f.adapter)
  assert.equal(f.state, receipt(f.target))
  await assert.rejects(retryUnappliedRebind(f.restore, f.root, f.adapter))
})

test("two approved recovery owners cannot stop one source concurrently", async (t) => {
  const f = fixture(t),
    old = JSON.parse(f.records.get(f.restore)),
    grant = JSON.parse(f.records.get(old.handoff))
  const secondOwner = "15:1",
    reversePlan = H({ ...f.target, owner: secondOwner }),
    nonce = H("second fresh nonce")
  const store = (v) => {
    const key = H(v)
    f.records.set(key, JSON.stringify(v))
    return key
  }
  const second = store({
    ...old,
    nonce,
    owner: secondOwner,
    reversePlan,
    handoff: store({ ...grant, newOwner: secondOwner, reversePlan, nonceHash: H(nonce) }),
  })
  let entered, resume
  const waiting = new Promise((ok) => {
      entered = ok
    }),
    release = new Promise((ok) => {
      resume = ok
    })
  f.adapter.stopLegacyConsumers = async () => {
    f.log.push("stop")
    entered()
    await release
  }
  const first = f.doRestore()
  await waiting
  try {
    await assert.rejects(
      restoreQualifiedPair(second, f.root, {
        ...f.adapter,
        readAuthenticatedOwner: async () => secondOwner,
      }),
      { code: "EEXIST" }
    )
  } finally {
    resume()
    await first
  }
  assert.equal(f.log.filter((x) => x === "stop").length, 1)
})

test("private selector getters and reader exceptions never leak private data", async (t) => {
  for (const mode of ["throw", "getter"]) {
    const f = fixture(t),
      orig = f.adapter.readArmedSelectorProof
    let invoked = false
    f.adapter.readArmedSelectorProof = async (...args) => {
      if (mode === "throw") throw new Error("private-selector")
      const v = await orig(...args)
      Object.defineProperty(v, "inputHash", {
        get() {
          invoked = true
          throw new Error("private-selector")
        },
      })
      return v
    }
    await assert.rejects(f.doArm(), (e) => e.message === "Protected paired runtime proof mismatch")
    assert.equal(invoked, false)
    assert.equal(f.state, receipt(f.src))
  }
})
