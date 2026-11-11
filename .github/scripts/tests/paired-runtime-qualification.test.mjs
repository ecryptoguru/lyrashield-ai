import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import test from "node:test"
import {
  assertPromotionActionLease,
  qualificationControlPlaneFields,
  readHeldBaselineArchive,
} from "../paired-runtime-qualification.mjs"
import { pairedReleaseReceipt } from "../../../ops/monitoring/paired-release-hold.mjs"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const digest = (value) => "sha256:" + hash(value)
const clone = (value) => structuredClone(value)
function tuple() {
  const pair = {
    owner: "42:1",
    productRevision: "a".repeat(40),
    engineRevision: "c".repeat(40),
    workerDigest: digest("worker"),
    webDigest: digest("web"),
    proxyDigest: digest("proxy"),
    priorWorkerDigest: digest("prior-worker"),
    sandboxDigest: digest("sandbox"),
    app: { candidate: "app--baseline", previous: "app--previous" },
    scanner: { candidate: "scanner--baseline", previous: "scanner--previous" },
    relay: { candidate: "relay--baseline", previous: "relay--previous" },
  }
  const controlPlane = Object.fromEntries(
    qualificationControlPlaneFields.map((key) => [key, digest(key)])
  )
  return { pair, controlPlane }
}
function baselineFixture() {
  const expected = tuple()
  const readback = {
    kind: "release-readback",
    owner: expected.pair.owner,
    ...clone(expected),
    admission: "held",
    holdReceipt: pairedReleaseReceipt(
      expected.pair.owner,
      expected.pair.productRevision,
      expected.pair.engineRevision,
      expected.pair.workerDigest
    ),
    holdPersistent: true,
    runRecordV11: "0",
    pendingHttpEvidence: "0",
    selectorPresent: false,
    oldServingReplicas: 0,
    workerCount: 1,
    relayCount: 1,
    readyCode: "200",
    readyBody: JSON.stringify({ status: "ready", checks: { database: true, redis: true } }),
    scansCode: "503",
    scansBody: JSON.stringify({ status: "not_ready", checks: { worker: false } }),
  }
  const record = {
    kind: "held-baseline",
    purpose: "rollback-only",
    ...clone(expected),
    releaseProof: hash(JSON.stringify(readback)),
    sandboxProof: hash("sandbox"),
    financialProof: hash("financial"),
    readerProof: hash("reader"),
    connectionProof: hash("connection"),
  }
  const events = []
  const artifacts = new Map()
  function add(value, overrides = {}) {
    const raw = JSON.stringify(value),
      id = hash(raw)
    artifacts.set(value.kind + ":" + id, {
      raw,
      owner: expected.pair.owner,
      source: expected.pair.productRevision,
      ...overrides,
    })
    return id
  }
  function rebuild(overrides = {}) {
    record.releaseProof = add(readback)
    return add(record, overrides)
  }
  const dependencies = {
    async verifyArtifact(kind, id) {
      events.push(kind)
      const artifact = artifacts.get(kind + ":" + id)
      if (!artifact) throw new Error("unverified fixture witness")
      return artifact
    },
  }
  return { expected, record, readback, dependencies, add, rebuild, artifacts, events }
}

test("held baseline requires separately authenticated held readback and exact rollback tuple", async () => {
  const f = baselineFixture()
  const record = await readHeldBaselineArchive(f.rebuild(), f.expected, f.dependencies)
  assert.equal(record.purpose, "rollback-only")
  assert.deepEqual(f.events, ["held-baseline", "release-readback"])
})

test("held baseline rejects open, foreign, expiring, non-drained and unavailable readiness", async () => {
  for (const [field, bad] of [
    ["admission", "open"],
    ["holdPersistent", false],
    ["holdReceipt", "foreign"],
    ["runRecordV11", "1"],
    ["pendingHttpEvidence", "1"],
    ["selectorPresent", true],
    ["oldServingReplicas", 1],
    ["workerCount", 2],
    ["relayCount", 0],
    ["readyCode", "503"],
    ["readyBody", "{}"],
    ["scansCode", "200"],
    ["scansBody", "{}"],
    ["owner", "43:1"],
  ]) {
    const f = baselineFixture()
    f.readback[field] = bad
    await assert.rejects(
      readHeldBaselineArchive(f.rebuild(), f.expected, f.dependencies),
      undefined,
      field
    )
  }
})

test("held baseline binds every runtime, control-plane and service revision field in both signed records", async () => {
  for (const target of ["record", "readback"]) {
    for (const field of Object.keys(tuple().pair)) {
      const f = baselineFixture()
      f[target].pair[field] =
        typeof f[target].pair[field] === "string"
          ? "foreign"
          : { candidate: "app--other", previous: "app--previous" }
      await assert.rejects(
        readHeldBaselineArchive(f.rebuild(), f.expected, f.dependencies),
        undefined,
        target + ":" + field
      )
    }
    for (const field of qualificationControlPlaneFields) {
      const f = baselineFixture()
      f[target].controlPlane[field] = digest("different")
      await assert.rejects(
        readHeldBaselineArchive(f.rebuild(), f.expected, f.dependencies),
        undefined,
        target + ":" + field
      )
      delete f[target].controlPlane[field]
      await assert.rejects(readHeldBaselineArchive(f.rebuild(), f.expected, f.dependencies))
    }
  }
})

test("held baseline rejects schema, identity, witness, raw-byte and proof substitution", async () => {
  for (const mutate of [
    (f) => {
      f.record.purpose = "admission"
    },
    (f) => {
      f.record.kind = "qualified-fleet"
    },
    (f) => {
      f.record.extra = "arbitrary"
    },
    (f) => {
      f.readback.extra = "arbitrary"
    },
    (f) => {
      f.record.sandboxProof = "missing"
    },
    (f) => {
      delete f.record.readerProof
    },
  ]) {
    const f = baselineFixture()
    mutate(f)
    await assert.rejects(readHeldBaselineArchive(f.rebuild(), f.expected, f.dependencies))
  }
  for (const overrides of [
    { source: "b".repeat(40) },
    { owner: "43:1" },
    { raw: "{}" },
    { raw: "x".repeat(4097) },
  ]) {
    const f = baselineFixture()
    await assert.rejects(readHeldBaselineArchive(f.rebuild(overrides), f.expected, f.dependencies))
  }
  const f = baselineFixture(),
    id = f.rebuild()
  f.artifacts.delete("release-readback:" + f.record.releaseProof)
  await assert.rejects(readHeldBaselineArchive(id, f.expected, f.dependencies))
  await assert.rejects(readHeldBaselineArchive("bad", f.expected, f.dependencies))
  await assert.rejects(
    readHeldBaselineArchive(id, f.expected, {
      verifyArtifact: async () => {
        throw new Error("no issuer")
      },
    })
  )
})

function runHeldAdapter(mutate = () => {}) {
  const f = baselineFixture()
  const p = f.expected.pair
  const binding = Object.fromEntries(
    [
      "productRevision",
      "engineRevision",
      "workerDigest",
      "webDigest",
      "proxyDigest",
      "sandboxDigest",
    ].map((key) => [key, p[key]])
  )
  const proofRecords = {
    sandbox: {
      kind: "sandbox-qualification",
      owner: p.owner,
      ...binding,
      amd64: "passed",
      arm64: "passed",
      manifestDigest: p.sandboxDigest,
      publishRunId: "10",
      publishAttempt: "1",
    },
    financial: {
      kind: "financial-qualification",
      owner: p.owner,
      ...binding,
      physicalCeiling: "passed",
      crashRecovery: "passed",
      workerLifetimeClaim: "passed",
      engineCiRunId: "20",
      engineCiAttempt: "1",
    },
    reader: {
      kind: "reader-qualification",
      owner: p.owner,
      ...binding,
      pendingFinalization: "passed",
      queueReconciliation: "passed",
      readerFingerprint: hash("reader"),
    },
    continuity: {
      kind: "continuity",
      purpose: "fleet-authority",
      environment: "azure-production",
      databaseIdentity: hash("database"),
      redisUrlHash: hash("redis"),
    },
  }
  mutate(proofRecords, f)
  f.record.sandboxProof = f.add(proofRecords.sandbox)
  f.record.financialProof = f.add(proofRecords.financial)
  f.record.readerProof = f.add(proofRecords.reader)
  f.record.connectionProof = f.add(proofRecords.continuity)
  const id = f.rebuild()
  const githubMock = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
export async function verifiedArtifact(kind,id) {
  globalThis.events.push(kind);
  const artifact=globalThis.fixture.artifacts[kind+":"+id];
  assert.ok(artifact,"unverified artifact");
  assert.equal(createHash("sha256").update(artifact.raw).digest("hex"),id);
  return artifact;
}
export function verifyEngineRun(run,attempt,engine,workflow) {
  assert.equal(attempt,"1"); assert.equal(engine,globalThis.fixture.expected.pair.engineRevision);
  assert.equal(run,workflow==="ci.yml"?"20":"10"); globalThis.events.push(workflow);
}
export function verifySandboxAttestation(pair,run,attempt) {
  assert.deepEqual(pair,globalThis.fixture.expected.pair);
  assert.equal(run,"10"); assert.equal(attempt,"1"); globalThis.events.push("attestation");
}
export const readAuthenticatedOwner=()=>{throw Error("unavailable")};
export const readProtectedRecord=readAuthenticatedOwner,verifyCurrentSource=readAuthenticatedOwner,
verifyEnvironmentApproval=readAuthenticatedOwner,protectedSessionCookie=readAuthenticatedOwner;
`
  const cloudMock = `
import assert from "node:assert/strict";
export function verifyImageSources(pair) {
  assert.deepEqual(pair,globalThis.fixture.expected.pair);globalThis.events.push("image-sources");
}`
  const transportMock = `export const guest=()=>{throw Error("physical operation forbidden")};export const liveRedis={};`
  const script = `
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
globalThis.fixture=JSON.parse(readFileSync(0,"utf8"));globalThis.events=[];
const mocks=globalThis.fixture.mocks;
registerHooks({resolve(specifier,context,next){
  const source=mocks[specifier];
  return source?{url:"data:text/javascript,"+encodeURIComponent(source),shortCircuit:true}:next(specifier,context);
}});
const { protectedLiveAdapter }=await import(process.argv[1]);
const adapter=protectedLiveAdapter();
try {
  const ok=await adapter.verifyHeldBaselineArchive(globalThis.fixture.id,globalThis.fixture.expected);
  let promoteRefused=false,openFleetRefused=false;
  try{await adapter.promoteStoppedWorker(globalThis.fixture.expected.pair)}catch{promoteRefused=true}
  try{await adapter.verifyQualifiedArchive(globalThis.fixture.id)}catch{openFleetRefused=true}
  process.stdout.write(JSON.stringify({ok,promoteRefused,openFleetRefused,events:globalThis.events}));
}catch{process.stdout.write(JSON.stringify({ok:false,events:globalThis.events}))}
`
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        new URL("../paired-runtime-live.mjs", import.meta.url).href,
      ],
      {
        input: JSON.stringify({
          id,
          expected: f.expected,
          artifacts: Object.fromEntries(f.artifacts),
          mocks: {
            "./paired-runtime-github.mjs": githubMock,
            "./paired-runtime-cloud.mjs": cloudMock,
            "./paired-live-transport.mjs": transportMock,
          },
        }),
        timeout: 10000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    )
  )
}

test("actual held adapter joins qualification proofs without enabling promotion or open fleet authority", () => {
  const result = runHeldAdapter()
  assert.equal(result.ok, true)
  assert.equal(result.promoteRefused, true)
  assert.equal(result.openFleetRefused, true)
  assert.deepEqual(result.events.slice(0, 10), [
    "held-baseline",
    "release-readback",
    "image-sources",
    "sandbox-qualification",
    "financial-qualification",
    "reader-qualification",
    "publish-sandbox.yml",
    "attestation",
    "ci.yml",
    "continuity",
  ])
  for (const mutate of [
    (r) => {
      r.sandbox.amd64 = "failed"
    },
    (r) => {
      r.financial.workerLifetimeClaim = "failed"
    },
    (r) => {
      r.reader.pendingFinalization = "failed"
    },
    (r) => {
      r.continuity.environment = "wrong"
    },
    (_r, f) => {
      f.readback.admission = "open"
    },
  ])
    assert.equal(runHeldAdapter(mutate).ok, false)
})

function leaseFixture() {
  const expected = {
    ...tuple(),
    owner: "42:1",
    qualificationSha256: hash("qualification"),
    action: "forward",
    epoch: 7,
    nonce: hash("nonce"),
  }
  const record = {
    kind: "promotion-action-lease",
    ...clone(expected),
    issuedAt: 1000,
    expiresAt: 1900,
  }
  const qualification = {
    kind: "qualified-release",
    qualified: true,
    owner: expected.owner,
    mode: "paired",
    conflictingMaintenance: false,
    ...clone(tuple()),
  }
  const state = {
    state: "active",
    now: 1001,
    owner: expected.owner,
    action: expected.action,
    epoch: expected.epoch,
    nonce: expected.nonce,
    qualificationSha256: expected.qualificationSha256,
  }
  const events = []
  const dependencies = {
    async verifyQualifiedRelease(id) {
      events.push("qualification")
      assert.equal(id, expected.qualificationSha256)
      return qualification
    },
    async verifyArtifact(kind, id) {
      events.push("lease")
      assert.equal(kind, "promotion-action-lease")
      assert.equal(id, hash(JSON.stringify(record)))
      return {
        raw: JSON.stringify(record),
        owner: record.pair.owner,
        source: record.pair.productRevision,
      }
    },
    async readLeaseState() {
      events.push("durable-state")
      return state
    },
  }
  const check = () =>
    assertPromotionActionLease(hash(JSON.stringify(record)), expected, dependencies)
  return { expected, record, qualification, state, dependencies, events, check }
}

test("action lease checks complete qualification before signed lease and authoritative durable state", async () => {
  for (const action of ["forward", "restore", "release"]) {
    for (const duration of [1, 300, 900]) {
      const f = leaseFixture()
      f.expected.action = f.record.action = f.state.action = action
      f.record.expiresAt = 1000 + duration
      f.state.now = 1000
      await f.check()
      assert.deepEqual(f.events, ["qualification", "lease", "durable-state"])
    }
  }
})

test("action lease refuses absent authorities, signing-health records and incomplete qualification", async () => {
  const f = leaseFixture()
  for (const missing of ["verifyQualifiedRelease", "readLeaseState"]) {
    const dependencies = { ...f.dependencies }
    delete dependencies[missing]
    await assert.rejects(
      assertPromotionActionLease(hash(JSON.stringify(f.record)), f.expected, dependencies)
    )
  }
  for (const bad of [
    {},
    { purpose: "signing-primitive-check-only" },
    { kind: "qualified-release", qualified: false },
  ]) {
    await assert.rejects(
      assertPromotionActionLease(hash(JSON.stringify(f.record)), f.expected, {
        ...f.dependencies,
        verifyQualifiedRelease: async () => bad,
      })
    )
  }
  for (const [field, bad] of [
    ["owner", "43:1"],
    ["mode", "ordinary"],
    ["conflictingMaintenance", true],
  ]) {
    await assert.rejects(
      assertPromotionActionLease(hash(JSON.stringify(f.record)), f.expected, {
        ...f.dependencies,
        verifyQualifiedRelease: async () => ({ ...f.qualification, [field]: bad }),
      })
    )
  }
})

test("action lease rejects each binding drift and malformed or overlong duration", async () => {
  for (const [field, bad] of [
    ["kind", "arm"],
    ["owner", "43:1"],
    ["qualificationSha256", hash("other")],
    ["action", "canary"],
    ["action", "release"],
    ["epoch", 8],
    ["epoch", 0],
    ["nonce", hash("other")],
    ["issuedAt", 1001],
    ["issuedAt", 0],
    ["issuedAt", 1.5],
    ["expiresAt", 1000],
    ["expiresAt", 999],
    ["expiresAt", 1901],
    ["expiresAt", 1900.5],
  ]) {
    const f = leaseFixture()
    f.record[field] = bad
    if (field === "issuedAt" && bad === 1001) f.state.now = 1000
    await assert.rejects(f.check(), undefined, field + ":" + bad)
  }
  for (const target of ["qualification", "record"]) {
    for (const field of qualificationControlPlaneFields) {
      const f = leaseFixture()
      f[target].controlPlane[field] = digest("different")
      await assert.rejects(f.check(), undefined, target + ":" + field)
    }
    for (const field of Object.keys(tuple().pair)) {
      const f = leaseFixture()
      f[target].pair[field] = "foreign"
      await assert.rejects(f.check(), undefined, target + ":" + field)
    }
  }
  const f = leaseFixture()
  f.record.extra = "unknown"
  await assert.rejects(f.check())
})

test("expiry, replay, epoch change and authoritative state uncertainty remain unusable", async () => {
  for (const [field, bad] of [
    ["now", 999],
    ["now", 1900],
    ["now", 1901],
    ["now", 1000.5],
    ["now", "1001"],
    ["state", "consumed"],
    ["state", "unknown"],
    ["owner", "42:2"],
    ["action", "restore"],
    ["epoch", 8],
    ["nonce", hash("replayed")],
    ["qualificationSha256", hash("different")],
  ]) {
    const f = leaseFixture()
    f.state[field] = bad
    await assert.rejects(f.check(), undefined, field + ":" + bad)
  }
  const f = leaseFixture()
  f.dependencies.readLeaseState = async () => {
    throw new Error("durable state unavailable")
  }
  await assert.rejects(f.check())
  f.dependencies.readLeaseState = async () => ({ ...f.state, unexpected: true })
  await assert.rejects(f.check())
  f.dependencies.readLeaseState = async () => null
  await assert.rejects(f.check())
})
