import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promoteHeldPair, releaseVerifiedPair } from "../paired-runtime-release.mjs"
import { pairedHold, assertPairedWorkDrained, waitForPairedDrain } from "../paired-runtime-hold.mjs"

const digest = (char) => "sha256:" + char.repeat(64)
const pair = {
  owner: "111:2",
  productRevision: "a".repeat(40),
  engineRevision: "b".repeat(40),
  workerDigest: digest("1"),
  webDigest: digest("2"),
  proxyDigest: digest("3"),
  priorWorkerDigest: digest("4"),
  sandboxDigest: digest("5"),
}
for (const name of ["app", "scanner", "relay"])
  pair[name] = { candidate: name + "--new", previous: name + "--old" }
const mutations = [
  "stop-legacy",
  "stage-relay",
  "stage-app",
  "stage-scanner",
  "route-relay",
  "retire-relay",
  "install-worker",
  "route-app",
  "retire-app",
  "route-scanner",
  "retire-scanner",
]
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "paired-runtime-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const log = []
  const f = { root, log, state: "absent", fail: "", mode: "", signal: new AbortController() }
  const run = (name) => {
    log.push(name)
    if (name !== f.fail) return
    if (f.mode === "replace") f.state = "foreign"
    if (f.mode === "lost") f.state = "absent"
    if (f.mode === "abort") {
      f.signal.abort()
      return
    }
    throw new Error("fault " + name)
  }
  const hold = {
    async assert() {
      assert.equal(f.state, "owned")
      run("assert")
    },
    async claim() {
      assert.equal(f.state, "absent")
      f.state = "owned"
      run("claim")
    },
    async release() {
      assert.equal(f.state, "owned")
      f.state = "absent"
      run("release")
    },
    async state() {
      return f.state
    },
  }
  let ownerReceipt
  const redis = {
    llen: async () => 0,
    zcard: async () => 0,
    async set(key, receipt, op) {
      assert.equal(op, "NX")
      if (f.state !== "absent") return null
      ownerReceipt = receipt
      await hold.claim()
      return "OK"
    },
    eval: async (lua, count, key, op, value) => {
      if (lua.includes('return "absent"')) return f.state
      if (f.state !== "owned" || value !== ownerReceipt) return 0
      await hold[op]()
      return 1
    },
  }
  const adapter = {
    redis,
    async readQualifiedRelease() {
      run("qualified")
      return {
        mode: "paired",
        qualified: true,
        conflictingMaintenance: false,
        pair,
        ...f.approvalDrift,
      }
    },
    db: { query: async () => ({ rows: [{ drained: true }] }) },
    async readPhysicalDrain() {
      run("drain")
      return "V26_EXECUTION_DRAIN_VERIFIED"
    },
    async stopLegacyConsumers() {
      run("stop-legacy")
    },
    async verifyStoppedLegacy() {
      run("stopped")
    },
    async stageAtZeroTraffic(name) {
      run("stage-" + name)
    },
    async verifyZeroTrafficCandidate() {
      run("zero-weight")
    },
    async promoteNamedRoute(name) {
      run("route-" + name)
    },
    async retirePreviousRevision(name) {
      run("retire-" + name)
    },
    async promoteStoppedWorker() {
      run("install-worker")
    },
    async readServingRoute(name) {
      run("read-" + name)
      return {
        revision: pair[name].candidate,
        digest: name === "relay" ? pair.proxyDigest : pair.webDigest,
        traffic: [{ revision: pair[name].candidate, weight: 100 }],
        oldRevisionReachable: false,
        oldServingReplicas: 0,
        otherServingRevisions: 0,
        healthy: true,
        replicas: 1,
        ownedGrantRefusalVerified: true,
        ...f.routeDrift,
      }
    },
    async readWorker() {
      run("worker")
      return {
        productRevision: pair.productRevision,
        engineRevision: pair.engineRevision,
        digest: pair.workerDigest,
        sandboxDigest: pair.sandboxDigest,
        sandboxImageMatchesRuntime: true,
        imageIdMatchesDigest: true,
        healthy: true,
        consumers: 1,
        canarySelectorPresent: false,
        runRecordV11: "0",
        pendingHttpEvidence: "0",
        ...f.workerDrift,
      }
    },
    async verifySourceAndConnectionContinuity() {
      run("continuity")
    },
    async readReadiness() {
      run("readiness")
      const open = f.state === "absent"
      return {
        readyCode: "200",
        readyBody: JSON.stringify({ status: "ready", checks: { database: true, redis: true } }),
        scansCode: open ? "200" : "503",
        scansBody: JSON.stringify({
          status: open ? "ready" : "not_ready",
          checks: { worker: open },
        }),
        ...f.readinessDrift,
      }
    },
    async containOwnedConsumers() {
      await hold.assert()
      run("contain")
    },
  }
  return Object.assign(f, {
    adapter,
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test’s private temporary fixture
    stages: () => readdirSync(join(root, pair.owner)),
    promote: () =>
      promoteHeldPair({ ...pair, injectedSecret: "never-persist" }, root, adapter, f.signal.signal),
    release: () => releaseVerifiedPair(pair, root, adapter, f.signal.signal),
  })
}

test("hold, drain, relay, VM, producers, fresh readback and separately consumed CAS", async (t) => {
  const f = fixture(t)
  await f.promote()
  assert.equal(f.state, "owned")
  assert.ok(!f.log.includes("release"))
  assert.deepEqual(
    f.log.filter((x) => mutations.includes(x)),
    mutations
  )
  assert.ok(f.log.indexOf("read-relay") < f.log.indexOf("install-worker"))
  assert.ok(f.log.indexOf("worker") < f.log.indexOf("route-app"))
  for (const stage of f.stages()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test’s private temporary fixture
    const record = JSON.parse(readFileSync(join(f.root, pair.owner, stage)))
    assert.deepEqual(record, { version: 1, stage, pair })
  }
  await assert.rejects(f.promote(), { code: "EEXIST" })
  await f.release()
  assert.equal(f.state, "absent")
  assert.ok(f.stages().includes("release-verified"))
  await assert.rejects(f.release(), { code: "EEXIST" })
  assert.equal(f.log.filter((x) => x === "release").length, 1)
})

for (const stage of mutations)
  test("fault immediately after " + stage, async (t) => {
    const f = fixture(t)
    f.fail = stage
    await assert.rejects(f.promote(), /fault|Paired worker promotion failed/)
    assert.equal(f.state, "owned")
    assert.deepEqual(
      f.log.filter((x) => mutations.includes(x)),
      mutations.slice(0, mutations.indexOf(stage) + 1)
    )
    assert.ok(f.stages().includes("contained"))
    await assert.rejects(f.release(), { code: "ENOENT" })
  })

for (const mode of ["lost", "replace", "abort"])
  test(mode + " during promotion", async (t) => {
    const f = fixture(t)
    f.fail = "install-worker"
    f.mode = mode
    await assert.rejects(f.promote())
    assert.ok(!f.log.includes("route-app"))
    assert.equal(f.log.includes("contain"), mode !== "replace")
    assert.equal(f.log.filter((x) => x === "claim").length, mode === "lost" ? 2 : 1)
    assert.equal(f.stages().includes("admission-gap"), mode === "lost")
  })

test("lost claim acknowledgement cannot auto-adopt or move traffic", async (t) => {
  const f = fixture(t)
  f.fail = "claim"
  await assert.rejects(f.promote(), /fault|Paired worker promotion failed/)
  assert.equal(f.state, "owned")
  assert.deepEqual(f.stages(), ["claim-intent"])
  await assert.rejects(f.promote(), { code: "EEXIST" })
})

test("foreign hold blocks before first mutation", async (t) => {
  const f = fixture(t)
  f.state = "foreign"
  await assert.rejects(f.promote())
  assert.equal(f.state, "foreign")
  assert.ok(!f.log.includes("contain"))
})

for (const [field, value] of [
  ["routeDrift", { oldRevisionReachable: true }],
  ["routeDrift", { replicas: 2 }],
  ["routeDrift", { traffic: [{ revision: "app--new", weight: 100, latestRevision: true }] }],
  ["routeDrift", { ownedGrantRefusalVerified: false }],
  ["workerDrift", { canarySelectorPresent: true }],
  ["workerDrift", { canarySelectorPresent: undefined }],
  ["workerDrift", { runRecordV11: "1" }],
  ["workerDrift", { pendingHttpEvidence: undefined }],
  [
    "workerDrift",
    { sandboxDigest: "sha256:73067cefe2138c89c1f63abb597f006f66eae22dca332a6b01398d870a638dcf" },
  ],
  ["workerDrift", { sandboxImageMatchesRuntime: false }],
  ["workerDrift", { consumers: 2 }],
  ["workerDrift", { imageIdMatchesDigest: false }],
  ["readinessDrift", { scansBody: "{}" }],
])
  test("fresh held readback refuses " + Object.keys(value)[0], async (t) => {
    const f = fixture(t)
    await f.promote()
    f[field] = value
    await assert.rejects(f.release())
    assert.ok(!f.log.includes("release"))
    assert.ok(f.stages().includes("contained"))
  })

test("lost release ACK records exposure, reacquires only absent latch, forbids replay", async (t) => {
  const f = fixture(t)
  await f.promote()
  f.fail = "release"
  await assert.rejects(f.release(), /fault/)
  assert.equal(f.state, "owned")
  assert.ok(f.stages().includes("admission-gap"))
  assert.ok(f.log.includes("contain"))
  await assert.rejects(f.release(), { code: "EEXIST" })
})

test("release ACK loss followed by a foreign stop preserves that stop", async (t) => {
  const f = fixture(t)
  await f.promote()
  f.fail = "release"
  f.mode = "replace"
  await assert.rejects(f.release())
  assert.equal(f.state, "foreign")
  assert.ok(!f.log.includes("contain"))
  assert.ok(f.stages().includes("ownership-unconfirmed"))
})

test("failed open-readiness after successful DEL records a new hold", async (t) => {
  const f = fixture(t)
  await f.promote()
  const original = f.adapter.readReadiness
  f.adapter.readReadiness = async () => ({
    ...(await original()),
    ...(f.state === "absent" ? { scansCode: "503" } : {}),
  })
  await assert.rejects(f.release())
  assert.ok(f.stages().includes("admission-gap"))
  assert.equal(f.state, "owned")
})

test("owned hold calls fixed Redis key and canonical bytes; NX has no TTL or adoption", async () => {
  let stored = null
  const log = []
  const redis = {
    async set(key, value, ...args) {
      assert.deepEqual(args, ["NX"])
      log.push(key)
      if (stored) return null
      stored = value
      return "OK"
    },
    eval: async (lua, count, key, op, receipt) => {
      assert.equal(count, 1)
      log.push(key)
      if (lua.includes('return "absent"'))
        return !stored ? "absent" : stored === op ? "owned" : "foreign"
      if (stored !== receipt) return 0
      if (op === "release") stored = null
      return 1
    },
  }
  const h = pairedHold(redis, pair)
  await h.claim()
  await assert.rejects(h.claim())
  assert.equal(await h.state(), "owned")
  await h.release()
  assert.equal(await h.state(), "absent")
  stored = "replaced"
  await assert.rejects(h.release())
  assert.equal(stored, "replaced")
  assert.ok(log.every((key) => key === "lyrashield:scan-admission:stopped"))
})

test("all three queue families, global database owners and physical children must be empty", async () => {
  const keys = [],
    sql = []
  let blocked = "",
    drained = true,
    physical = "V26_EXECUTION_DRAIN_VERIFIED"
  const count = async (key) => {
    keys.push(key)
    return key === blocked ? 1 : 0
  }
  const db = {
    async query(query) {
      sql.push(query)
      return { rows: [{ drained }] }
    },
  }
  const run = () => assertPairedWorkDrained({ llen: count, zcard: count }, db, async () => physical)
  await run()
  assert.equal(new Set(keys).size, 18)
  for (const key of [...keys]) {
    blocked = key
    await assert.rejects(run(), /queue/)
  }
  blocked = ""
  drained = false
  await assert.rejects(run(), /ownership/)
  assert.equal(sql.at(-1), "ROLLBACK")
  for (const model of [
    "Scan",
    "WebhookEventTrack",
    "UserScanSlot",
    "ScanCapacityReservation",
    "AgentApproval",
    "agent_operations",
  ])
    assert.ok(sql.some((query) => query.includes(model)))
  drained = true
  physical = ""
  await assert.rejects(run())
})

for (const bad of [
  { mode: "ordinary" },
  { qualified: false },
  { conflictingMaintenance: true },
  { pair: { ...pair, webDigest: digest("5") } },
  { pair: { ...pair, owner: "111:3" } },
]) {
  test("mismatched protected approval stops before claim " + JSON.stringify(bad), async (t) => {
    const f = fixture(t)
    f.approvalDrift = bad
    await assert.rejects(f.promote())
    assert.deepEqual(f.log, ["qualified"])
    assert.equal(f.state, "absent")
  })
}

test("bounded drain retries only confirmed busy work and reasserts the latch", async () => {
  let checks = 0,
    busy = true
  const redis = {
    eval: async () => {
      checks++
      return 1
    },
    llen: async () => {
      if (busy) {
        busy = false
        return 1
      }
      return 0
    },
    zcard: async () => 0,
  }
  const db = { query: async () => ({ rows: [{ drained: true }] }) }
  await waitForPairedDrain(pair, redis, db, async () => "V26_EXECUTION_DRAIN_VERIFIED")
  assert.equal(checks, 3)
  await assert.rejects(
    waitForPairedDrain(
      pair,
      { ...redis, llen: async () => undefined },
      db,
      async () => "V26_EXECUTION_DRAIN_VERIFIED"
    ),
    /invalid queue count/
  )
  const controller = new AbortController()
  await assert.rejects(
    waitForPairedDrain(
      pair,
      {
        ...redis,
        llen: async () => {
          controller.abort()
          return 1
        },
      },
      db,
      async () => "V26_EXECUTION_DRAIN_VERIFIED",
      controller.signal
    ),
    { name: "AbortError" }
  )
})

test("pre-release gap after routing app is contained before scanner or CAS", async (t) => {
  const f = fixture(t)
  f.fail = "route-app"
  f.mode = "lost"
  await assert.rejects(f.promote())
  assert.equal(f.state, "owned")
  assert.ok(f.stages().includes("admission-gap"))
  assert.ok(f.stages().includes("contained"))
  assert.ok(!f.log.includes("route-scanner"))
  assert.ok(!f.log.includes("release"))
})

test("foreign claim winning the gap race is left in place", async (t) => {
  const f = fixture(t)
  f.fail = "route-app"
  f.mode = "lost"
  const set = f.adapter.redis.set
  f.adapter.redis.set = async (...args) => {
    if (f.log.includes("route-app")) f.state = "foreign"
    return set(...args)
  }
  await assert.rejects(f.promote())
  assert.equal(f.state, "foreign")
  assert.ok(!f.log.includes("contain"))
  assert.ok(f.stages().includes("admission-gap"))
  assert.ok(f.stages().includes("ownership-unconfirmed"))
})
test("unavailable hold observation records uncertainty without an NX attempt", async (t) => {
  const f = fixture(t)
  f.fail = "route-app"
  f.mode = "lost"
  const evaluate = f.adapter.redis.eval
  f.adapter.redis.eval = async (...args) => {
    if (args[0].includes('return "absent"')) throw new Error("Redis read lost")
    return evaluate(...args)
  }
  await assert.rejects(f.promote())
  assert.ok(f.stages().includes("ownership-unconfirmed"))
  assert.ok(!f.stages().includes("admission-gap"))
  assert.equal(f.log.filter((x) => x === "claim").length, 1)
})

test("malformed worker proof cannot print a canary selector", async (t) => {
  const f = fixture(t)
  await f.promote()
  f.workerDrift = { canarySelectorPresent: "private-synthetic-value" }
  await assert.rejects(
    f.release(),
    (error) =>
      error.message.includes("writer-off proof mismatch") &&
      !error.message.includes("private-synthetic-value")
  )
})

for (const [stderr, expected] of [
  [
    "Paired VM completion unverified (guest stage promote, exit 17)",
    { kind: "guest", stage: "promote", exit: 17 },
  ],
  [
    "Paired VM transport: timeout\nPaired VM transport exit 124; guest status unknown",
    { kind: "transport", exit: 124, category: "timeout" },
  ],
  ["private-untrusted-output", { kind: "unknown" }],
])
  test("private worker failure record retains only " + expected.kind + " metadata", async (t) => {
    const f = fixture(t)
    f.adapter.promoteStoppedWorker = async () => {
      throw Object.assign(new Error("private-untrusted-output"), { stderr })
    }
    await assert.rejects(f.promote(), /inspect the protected stage record/)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- private temporary release fixture
    const raw = readFileSync(join(f.root, pair.owner, "worker-promotion-failed"), "utf8")
    assert.ok(!raw.includes("private-untrusted-output"))
    assert.deepEqual(JSON.parse(raw), {
      version: 1,
      stage: "worker-promotion-failed",
      pair,
      workerFailure: expected,
    })
  })

test("sandbox qualification is mandatory before any ordinary paired claim", async (t) => {
  const f = fixture(t)
  for (const input of [
    { ...pair, sandboxDigest: undefined },
    { ...pair, sandboxDigest: "latest" },
  ]) {
    await assert.rejects(promoteHeldPair(input, f.root, f.adapter))
    assert.equal(f.state, "absent")
    assert.deepEqual(f.log, [])
  }
  f.approvalDrift = {
    pair: {
      ...pair,
      sandboxDigest: "sha256:73067cefe2138c89c1f63abb597f006f66eae22dca332a6b01398d870a638dcf",
    },
  }
  await assert.rejects(f.promote())
  assert.equal(f.state, "absent")
  assert.deepEqual(f.log, ["qualified"])
})

test("shared stage backend is awaited before stop and retains hold after an unknown write", async (t) => {
  const f = fixture(t)
  let entered, rejectWrite
  const blocked = new Promise((resolve) => {
    entered = resolve
  })
  f.adapter.stageStore = {
    directory: async () => {},
    createDirectory: async () => {},
    async write(_owner, stage) {
      if (stage === "stop-legacy") {
        entered()
        await new Promise((_resolve, reject) => {
          rejectWrite = reject
        })
      }
    },
  }
  const pending = f.promote()
  await blocked
  assert.equal(f.state, "owned")
  assert.ok(!f.log.includes("stop-legacy"))
  rejectWrite(new Error("write acknowledgement unknown"))
  await assert.rejects(pending, /acknowledgement unknown/)
  assert.equal(f.state, "owned")
  assert.ok(f.log.includes("contain"))
})

test("remote stage receipts gate release and cannot be adopted by a replay", async (t) => {
  const f = fixture(t),
    records = new Map(),
    directories = new Set([""])
  f.adapter.stageStore = {
    async directory(owner) {
      assert.ok(directories.has(owner))
    },
    async createDirectory(owner) {
      assert.ok(!directories.has(owner))
      directories.add(owner)
    },
    async write(owner, stage, body) {
      const key = owner + "/" + stage
      assert.ok(!records.has(key))
      records.set(key, JSON.stringify(body))
    },
    async assert(owner, stage, body) {
      assert.equal(records.get(owner + "/" + stage), JSON.stringify(body))
    },
  }
  await f.promote()
  assert.ok(records.has(pair.owner + "/pair-held-verified"))
  await assert.rejects(f.promote())
  await f.release()
  assert.equal(f.state, "absent")
  await assert.rejects(f.release())
  assert.equal(f.log.filter((x) => x === "release").length, 1)
})
