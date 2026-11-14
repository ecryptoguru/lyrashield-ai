import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { createProtectedRuntimeFleetIssuer } from "../issue-runtime-fleet-qualification.mjs"
import { canonicalJson } from "../../../packages/runtime-control/src/canonical-json.ts"
import { runtimeQualificationKeyId } from "../../../packages/security/src/sandbox-publication-record.ts"

const source = "1".repeat(40)
const engine = "2".repeat(40)
const tree = "3".repeat(40)
const digest = (value) => "sha256:" + value.repeat(64)
const hash = (raw) => createHash("sha256").update(raw).digest("hex")
const identity = { token: "oidc", identity: { owner: "42:1", source } }
const fleet = {
  productRevision: source,
  engineRevision: engine,
  webDigest: digest("a"),
  proxyDigest: digest("b"),
  workerDigest: digest("c"),
  sandboxDigest: digest("d"),
  brokerDigest: digest("e"),
  supervisorDigest: digest("f"),
  providerGatewayDigest: digest("9"),
  migrationChecksum: digest("8"),
  runtimePolicyDigest: digest("7"),
}
const checks = Object.fromEntries(
  [
    "admission",
    "executor-authority",
    "provider-dispatch",
    "receipt-settlement",
    "cancellation",
    "reconciliation",
    "revocation-races",
    "lost-acknowledgements",
    "journal-v2",
    "restore",
    "compatible-rollback",
  ].map((name) => [name, { state: "PASSED", receiptSha256: "0".repeat(64) }])
)
const fleetHash = hash(canonicalJson(fleet))
const evidence = {
  native: {
    kind: "evidence",
    owner: "42:1",
    source,
    fleetSha256: fleetHash,
    schema: "lyrashield-runtime-fleet-acceptance/1",
    scope: "disposable-linux",
    sourceTree: tree,
    fleet,
    architecture: "amd64",
    checks,
  },
  migration: {
    kind: "evidence",
    owner: "42:1",
    source,
    fleetSha256: fleetHash,
    schema: "lyrashield-runtime-migration-evidence/1",
    migrationChecksum: fleet.migrationChecksum,
    schemaProofSha256: "0".repeat(64),
    baselineMigrationChecksum: digest("6"),
    additiveCompatibilityProofSha256: "0".repeat(64),
  },
  policy: {
    kind: "evidence",
    owner: "42:1",
    source,
    fleetSha256: fleetHash,
    schema: "lyrashield-runtime-policy-evidence/1",
    runtimePolicyDigest: fleet.runtimePolicyDigest,
    restrictedIdentitiesProofSha256: "0".repeat(64),
    executionDescriptorProofSha256: "0".repeat(64),
    privateControlProofSha256: "0".repeat(64),
  },
  journal: {
    kind: "evidence",
    owner: "42:1",
    source,
    fleetSha256: fleetHash,
    schema: "lyrashield-runtime-journal-evidence/1",
    sealSchema: "lyrashield-journal-seal/2",
    sealHash: "0".repeat(64),
    recoverySnapshotSha256: "0".repeat(64),
    pinEnvelopeHash: "0".repeat(64),
    observedControlCasAckHash: "0".repeat(64),
    observedJournalAckHash: "0".repeat(64),
    observedSealAckHash: "0".repeat(64),
    postgresHeadHash: "4".repeat(64),
    r2HeadHash: "4".repeat(64),
    sequence: 7,
  },
}
const archived = {
  kind: "qualified-fleet",
  schema: "lyrashield-qualified-fleet/2",
  pair: {
    owner: "42:1",
    productRevision: "5".repeat(40),
    engineRevision: engine,
    workerDigest: digest("3"),
    webDigest: digest("2"),
    proxyDigest: digest("1"),
    priorWorkerDigest: digest("0"),
    sandboxDigest: digest("d"),
    app: { candidate: "app--b", previous: "app--a" },
    scanner: { candidate: "scanner--b", previous: "scanner--a" },
    relay: { candidate: "relay--b", previous: "relay--a" },
  },
  controlPlane: {
    migrationChecksum: digest("6"),
    brokerDigest: fleet.brokerDigest,
    supervisorDigest: fleet.supervisorDigest,
    providerGatewayDigest: fleet.providerGatewayDigest,
    runtimePolicyDigest: fleet.runtimePolicyDigest,
  },
  releaseProof: "0".repeat(64),
  sandboxProof: "0".repeat(64),
  financialProof: "0".repeat(64),
  readerProof: "0".repeat(64),
  connectionProof: "0".repeat(64),
}
const artifacts = new Map()
const remember = (raw, owner, artifactSource, id) => {
  artifacts.set(id ?? hash(raw), { raw, owner, source: artifactSource })
}
const rawOf = (value) => JSON.stringify(value)
for (const name of ["native", "migration", "policy", "journal"])
  remember(rawOf(evidence[name]), "42:1", source)
const archiveRaw = rawOf(archived)
remember(archiveRaw, "42:1", archived.pair.productRevision)
const selector = {
  native: hash(rawOf(evidence.native)),
  migration: hash(rawOf(evidence.migration)),
  policy: hash(rawOf(evidence.policy)),
  journal: hash(rawOf(evidence.journal)),
  rollback: hash(archiveRaw),
  inventory: {
    sandboxDigest: fleet.sandboxDigest,
    engineRevision: engine,
    publicationRevision: "a".repeat(40),
    publishRunId: "7",
    publishAttempt: "1",
    verifierRevision: "b".repeat(40),
    verifierRunId: "8",
    verifierAttempt: "1",
  },
}
const inventory = {
  qualified: false,
  nativeInventoryRechecked: true,
  runtimeAuthorityVerified: false,
  sandboxDigest: fleet.sandboxDigest,
  engineRevision: engine,
}
const common = {
  readIdentity: async () => identity,
  readSource: async () => ({ owner: "42:1", source }),
  readArtifact: async (kind, id) => {
    const artifact = artifacts.get(id)
    assert.ok(artifact, `missing ${kind} ${id}`)
    return artifact
  },
  verifyInventory: async () => inventory,
  verifyImages: async () => {},
  verifyControllers: async () => {},
  tree: () => tree,
  clock: () => Date.parse("2026-11-13T00:00:00.000Z"),
  witness: async (kind) => rawOf({ version: 1, kind }),
}

test("issues one exact-artifact record and signs only its constructed bytes", async () => {
  const calls = []
  let constructed
  const issued = await createProtectedRuntimeFleetIssuer({
    ...common,
    run: (args) => {
      calls.push(args[0])
      if (args[0] !== "keyvault") return null
      assert.equal(args[args.indexOf("--id") + 1], runtimeQualificationKeyId)
      assert.equal(args[args.indexOf("--algorithm") + 1], "RS256")
      return {
        algorithm: "RS256",
        keyId: runtimeQualificationKeyId,
        signature: args[args.indexOf("--digest") + 1],
      }
    },
    verifySignature: (raw, result) => {
      constructed = raw
      assert.equal(result.signature, createHash("sha256").update(raw).digest("base64"))
    },
  }).issue(selector)
  assert.deepEqual(calls, ["login", "keyvault", "logout"])
  const record = JSON.parse(issued.envelope.raw)
  assert.equal(record.purpose, "exact-artifact-release")
  assert.equal(record.scope, "disposable-linux")
  assert.equal(record.issuer.workflow, ".github/workflows/issue-runtime-qualification.yml")
  assert.equal(record.issuer.source, source)
  assert.equal(record.fleet.productRevision, source)
  assert.equal(record.evidence.inventory, hash(canonicalJson(inventory)))
  assert.ok(Buffer.byteLength(constructed) <= 4096)
  assert.equal(issued.receipt.qualificationSha256, hash(issued.envelope.raw))
  assert.ok(Object.isFrozen(issued.envelope) && Object.isFrozen(issued))
})

test("rejects unauthenticated or non-held evidence before any credential exchange", async () => {
  for (const [failure, override] of [
    [
      "identity",
      {
        readIdentity: async () => {
          throw Error("unavailable")
        },
      },
    ],
    ["owner", { readSource: async () => ({ owner: "43:1", source }) }],
    ["inventory", { verifyInventory: async () => ({ ...inventory, qualified: true }) }],
    [
      "runtime authority",
      { verifyInventory: async () => ({ ...inventory, runtimeAuthorityVerified: true }) },
    ],
    ["source tree", { tree: () => "f".repeat(40) }],
  ]) {
    const calls = []
    await assert.rejects(
      createProtectedRuntimeFleetIssuer({
        ...common,
        ...override,
        run: (args) => calls.push(args[0]),
      }).issue(selector),
      /./,
      failure
    )
    assert.deepEqual(calls, [], failure)
  }
})

test("rejects incomplete native checks and mismatched rollback tuples before signing", async () => {
  const badNative = structuredClone(evidence.native)
  badNative.checks.admission.state = "FAILED"
  const nativeRaw = rawOf(badNative)
  const failures = [
    {
      selector: { ...selector, native: hash(nativeRaw) },
      raw: nativeRaw,
      owner: "42:1",
      source,
      kind: "evidence",
    },
    ...[
      { pair: { ...archived.pair, workerDigest: fleet.workerDigest } },
      { pair: { ...archived.pair, engineRevision: "f".repeat(40) } },
      { controlPlane: { ...archived.controlPlane, migrationChecksum: digest("f") } },
      { source: "f".repeat(40) },
      { owner: "43:1" },
    ].map((change) => {
      const { source: artifactSource, owner: artifactOwner, ...fields } = change
      const body = { ...archived, ...fields }
      const raw = rawOf(body)
      return {
        selector: { ...selector, rollback: hash(raw) },
        raw,
        owner: artifactOwner ?? body.pair.owner,
        source: artifactSource ?? body.pair.productRevision,
        kind: "qualified-fleet",
      }
    }),
  ]
  for (const failure of failures) {
    const calls = []
    const badId = hash(failure.raw)
    await assert.rejects(
      createProtectedRuntimeFleetIssuer({
        ...common,
        readArtifact: async (kind, id) =>
          id === badId
            ? { raw: failure.raw, owner: failure.owner, source: failure.source }
            : common.readArtifact(kind, id),
        run: (args) => calls.push(args[0]),
      }).issue(failure.selector)
    )
    assert.deepEqual(calls, [], failure.kind)
  }
})

test("stops at signing failure and always logs out without emitting a record", async () => {
  const calls = []
  await assert.rejects(
    createProtectedRuntimeFleetIssuer({
      ...common,
      run: (args) => {
        calls.push(args[0])
        if (args[0] === "keyvault") throw Error("unavailable")
        return null
      },
    }).issue(selector)
  )
  assert.deepEqual(calls, ["login", "keyvault", "logout"])
})
