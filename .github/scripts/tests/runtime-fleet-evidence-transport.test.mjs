// Synthetic protocol fixtures validate transport only; they are never release evidence.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import test from "node:test"
import {
  createRuntimeFleetEvidenceTransport,
  readRootObservedRuntimeRecord,
} from "../runtime-fleet-evidence-transport.mjs"
import {
  runtimeFleetChecks,
  runtimeFleetEvidenceConfigurationSchema,
  validateRuntimeFleetEvidence,
} from "../issue-runtime-fleet-qualification.mjs"
import { canonicalJson } from "../../../packages/runtime-control/src/canonical-json.ts"

const sha = (raw) => createHash("sha256").update(raw).digest("hex")
const { parse } = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)("yaml")
const digest = (value) => `sha256:${value.repeat(64)}`
const source = "a".repeat(40)
const engine = "b".repeat(40)
const identity = { owner: "42:1", source }
const fleet = {
  productRevision: source,
  engineRevision: engine,
  webDigest: digest("1"),
  workerDigest: digest("2"),
  proxyDigest: digest("3"),
  brokerDigest: digest("4"),
  supervisorDigest: digest("5"),
  providerGatewayDigest: digest("6"),
  sandboxDigest: digest("7"),
  migrationChecksum: digest("8"),
  runtimePolicyDigest: digest("9"),
}
const prepared = {
  runId: "42",
  runAttempt: "1",
  ...Object.fromEntries(
    Object.entries(fleet).filter(
      ([key]) => key !== "migrationChecksum" && key !== "runtimePolicyDigest"
    )
  ),
}
const header = {
  kind: "evidence",
  owner: identity.owner,
  source,
  fleetSha256: sha(canonicalJson(fleet)),
}
const records = {
  native: {
    ...header,
    schema: "lyrashield-runtime-fleet-acceptance/1",
    scope: "disposable-linux",
    sourceTree: "c".repeat(40),
    architecture: "amd64",
    fleet,
    checks: Object.fromEntries(
      runtimeFleetChecks.map((name) => [name, { state: "PASSED", receiptSha256: sha(name) }])
    ),
  },
  migration: {
    ...header,
    schema: "lyrashield-runtime-migration-evidence/1",
    migrationChecksum: fleet.migrationChecksum,
    schemaProofSha256: sha("schema"),
    baselineMigrationChecksum: digest("a"),
    additiveCompatibilityProofSha256: sha("additive"),
  },
  policy: {
    ...header,
    schema: "lyrashield-runtime-policy-evidence/1",
    runtimePolicyDigest: fleet.runtimePolicyDigest,
    restrictedIdentitiesProofSha256: sha("identities"),
    executionDescriptorProofSha256: sha("descriptor"),
    privateControlProofSha256: sha("control"),
  },
  journal: {
    ...header,
    schema: "lyrashield-runtime-journal-evidence/1",
    sealSchema: "lyrashield-journal-seal/2",
    sealHash: sha("seal"),
    recoverySnapshotSha256: sha("snapshot"),
    pinEnvelopeHash: sha("pin"),
    observedControlCasAckHash: sha("control ack"),
    observedJournalAckHash: sha("journal ack"),
    observedSealAckHash: sha("seal ack"),
    postgresHeadHash: sha("head"),
    r2HeadHash: sha("head"),
    sequence: 1,
  },
}
const rollback = {
  kind: "qualified-fleet",
  schema: "lyrashield-qualified-fleet/2",
  pair: {
    owner: "41:1",
    productRevision: "d".repeat(40),
    engineRevision: engine,
    webDigest: digest("a"),
    workerDigest: digest("b"),
    proxyDigest: digest("c"),
    priorWorkerDigest: digest("d"),
    sandboxDigest: fleet.sandboxDigest,
    app: { candidate: "app--b", previous: "app--a" },
    scanner: { candidate: "scanner--b", previous: "scanner--a" },
    relay: { candidate: "relay--b", previous: "relay--a" },
  },
  controlPlane: {
    migrationChecksum: digest("a"),
    brokerDigest: fleet.brokerDigest,
    supervisorDigest: fleet.supervisorDigest,
    providerGatewayDigest: fleet.providerGatewayDigest,
    runtimePolicyDigest: fleet.runtimePolicyDigest,
  },
  releaseProof: sha("release"),
  sandboxProof: sha("sandbox"),
  financialProof: sha("financial"),
  readerProof: sha("reader"),
  connectionProof: sha("connection"),
}
const rollbackRaw = JSON.stringify(rollback)
const locator = {
  runId: "41",
  attempt: "1",
  artifactId: "410",
  source: rollback.pair.productRevision,
}
const config = {
  rollback: sha(rollbackRaw),
  inventory: {
    sandboxDigest: fleet.sandboxDigest,
    engineRevision: engine,
    publicationRevision: "e".repeat(40),
    publishRunId: "7",
    publishAttempt: "1",
    verifierRevision: "f".repeat(40),
    verifierRunId: "8",
    verifierAttempt: "1",
  },
}
const raw = {
  ...Object.fromEntries(
    Object.entries(records).map(([name, body]) => [`${name}.json`, JSON.stringify(body)])
  ),
  "rollback.json": rollbackRaw,
  "rollback.locator.json": JSON.stringify(locator),
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "lyrashield-evidence-transport-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    observedDirectory: "synthetic-test-input",
    recordDirectory: join(root, "records"),
    witnessDirectory: join(root, "witnesses"),
    prepared,
    configuration: config,
  }
}

test("validates exact observed fleet facts and config without generating missing checks", () => {
  validateRuntimeFleetEvidence(records, identity, prepared)
  for (const name of Object.keys(records)) {
    assert.throws(() =>
      validateRuntimeFleetEvidence(
        { ...records, [name]: { ...records[name], owner: "43:1" } },
        identity,
        prepared
      )
    )
    assert.throws(() =>
      validateRuntimeFleetEvidence(
        { ...records, [name]: { ...records[name], fleetSha256: sha("other") } },
        identity,
        prepared
      )
    )
  }
  const incomplete = structuredClone(records)
  delete incomplete.native.checks["executor-authority"]
  assert.throws(() => validateRuntimeFleetEvidence(incomplete, identity, prepared))
  assert.throws(() =>
    runtimeFleetEvidenceConfigurationSchema.parse({ ...config, native: sha("future") })
  )
  assert.throws(() =>
    validateRuntimeFleetEvidence(
      { ...records, journal: { ...records.journal, r2HeadHash: sha("other") } },
      identity,
      prepared
    )
  )
})

test("witnesses exact producer bytes and binds actual artifact IDs before emitting selectors", async (t) => {
  const options = fixture(t)
  const witnessed = []
  const verified = []
  const digests = Object.fromEntries(
    Object.entries(records).map(([name]) => [name, sha(raw[`${name}.json`])])
  )
  const artifactIds = { native: "101", migration: "102", policy: "103", journal: "104" }
  const transport = createRuntimeFleetEvidenceTransport({
    readObserved: (_, name) => raw[name],
    readIdentity: async () => ({ identity }),
    witness: async (kind, body, workflow) => {
      witnessed.push({ kind, body, workflow })
      return JSON.stringify({
        version: 1,
        kind,
        digest: sha(body),
        token: randomBytes(24).toString("hex"),
      })
    },
    verifyArtifact: async (kind, hash, workflow) => {
      verified.push({ kind, hash, workflow })
      if (kind === "qualified-fleet") return { raw: rollbackRaw }
      const name = Object.keys(digests).find((key) => digests[key] === hash)
      return {
        raw: raw[`${name}.json`],
        owner: identity.owner,
        source,
        artifactId: artifactIds[name],
      }
    },
  })
  const output = await transport.witness(options)
  for (const name of Object.keys(records)) {
    assert.equal(output[`${name}_digest`], digests[name])
    assert.equal(output[`${name}_artifact_name`], `paired-v1-42-1-evidence-${digests[name]}`)
  }
  assert.deepEqual(
    witnessed.map((item) => item.body),
    Object.keys(records).map((name) => raw[`${name}.json`])
  )
  assert.ok(
    witnessed.every(
      (item) =>
        item.kind === "evidence" &&
        item.workflow === ".github/workflows/issue-runtime-qualification.yml"
    )
  )
  const selectors = await transport.locate({
    recordDirectory: options.recordDirectory,
    digests,
    artifactIds,
    prepared,
    configuration: config,
  })
  assert.deepEqual(selectors, { ...digests, ...config })
  assert.equal(verified.length, 5)
  const path = join(options.recordDirectory, `${digests.native}.locator.json`)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated test-owned hash-addressed output
  const saved = JSON.parse(readFileSync(path, "utf8"))
  assert.deepEqual(saved, { runId: "42", attempt: "1", artifactId: "101", source })
})

test("refuses missing source, altered facts and absent independent rollback before witnessing", async (t) => {
  for (const mutation of [
    { "native.json": undefined },
    { "journal.json": JSON.stringify({ ...records.journal, sealHash: undefined }) },
    { "rollback.json": "{}" },
    { "rollback.locator.json": JSON.stringify({ ...locator, runId: "40" }) },
  ]) {
    const options = fixture(t)
    let calls = 0
    const transport = createRuntimeFleetEvidenceTransport({
      readObserved: (_, name) => (Object.hasOwn(mutation, name) ? mutation[name] : raw[name]),
      readIdentity: async () => ({ identity }),
      witness: async () => {
        calls += 1
        return "unreachable"
      },
    })
    await assert.rejects(transport.witness(options))
    assert.equal(calls, 0)
  }
})

test("transports an explicit held archive without minting its witness or recovery authority", async (t) => {
  const baseline = structuredClone(rollback)
  baseline.kind = "held-baseline"
  baseline.purpose = "rollback-only"
  delete baseline.schema
  const baselineRaw = JSON.stringify(baseline)
  const options = {
    ...fixture(t),
    configuration: { ...config, rollback: sha(baselineRaw), rollbackKind: "held-baseline" },
  }
  const artifactIds = { native: "101", migration: "102", policy: "103", journal: "104" }
  const digests = Object.fromEntries(
    Object.keys(records).map((name) => [name, sha(raw[`${name}.json`])])
  )
  const calls = []
  const transport = createRuntimeFleetEvidenceTransport({
    readObserved: (_, name) => (name === "rollback.json" ? baselineRaw : raw[name]),
    readIdentity: async () => ({ identity }),
    witness: async (kind, body) => {
      calls.push(`witness:${kind}`)
      return JSON.stringify({ kind, digest: sha(body), token: "synthetic" })
    },
    verifyArtifact: async (kind, hash) => {
      calls.push(`verify:${kind}`)
      if (kind === "held-baseline") return { raw: baselineRaw }
      const name = Object.keys(digests).find((key) => digests[key] === hash)
      return {
        raw: raw[`${name}.json`],
        owner: identity.owner,
        source,
        artifactId: artifactIds[name],
      }
    },
  })
  await transport.witness(options)
  const selectors = await transport.locate({
    recordDirectory: options.recordDirectory,
    digests,
    artifactIds,
    prepared,
    configuration: options.configuration,
  })
  assert.equal(selectors.rollbackKind, "held-baseline")
  assert.equal(calls.at(-1), "verify:held-baseline")
  assert.deepEqual(
    calls.filter((item) => item.startsWith("witness:")),
    Array(4).fill("witness:evidence")
  )

  const implicit = { ...fixture(t), configuration: { ...config, rollback: sha(baselineRaw) } }
  await assert.rejects(transport.witness(implicit))
  assert.throws(() =>
    runtimeFleetEvidenceConfigurationSchema.parse({ ...config, rollbackKind: "legacy" })
  )
})

test("refuses changed private facts, run, configuration and substituted artifact IDs", async (t) => {
  for (const mode of ["configuration", "raw", "run", "artifact"]) {
    const options = fixture(t)
    let currentIdentity = identity
    const artifactIds = { native: "101", migration: "102", policy: "103", journal: "104" }
    const digests = Object.fromEntries(
      Object.keys(records).map((name) => [name, sha(raw[`${name}.json`])])
    )
    const transport = createRuntimeFleetEvidenceTransport({
      readObserved: (_, name) => raw[name],
      readIdentity: async () => ({ identity: currentIdentity }),
      witness: async (kind, body) =>
        JSON.stringify({ kind, digest: sha(body), token: randomBytes(24).toString("hex") }),
      verifyArtifact: async (kind, digest) => {
        if (kind === "qualified-fleet") return { raw: rollbackRaw }
        const name = Object.keys(digests).find((key) => digests[key] === digest)
        return {
          raw: raw[`${name}.json`],
          owner: identity.owner,
          source,
          artifactId: mode === "artifact" ? "999" : artifactIds[name],
        }
      },
    })
    await transport.witness(options)
    if (mode === "run") currentIdentity = { ...identity, owner: "43:1" }
    if (mode === "raw") {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated hash-addressed test output
      writeFileSync(join(options.recordDirectory, `${digests.native}.json`), "{}")
    }
    await assert.rejects(
      transport.locate({
        recordDirectory: options.recordDirectory,
        digests,
        artifactIds,
        prepared,
        configuration: mode === "configuration" ? { ...config, rollback: sha("another") } : config,
      })
    )
  }
})

test("protected workflow uploads each hash witness before deriving current-run selectors", () => {
  const issuer = parse(readFileSync(".github/workflows/issue-runtime-qualification.yml", "utf8"))
  const release = parse(readFileSync(".github/workflows/release-production.yml", "utf8"))
  assert.equal(
    release.jobs["qualify-runtime"].with.runtime_fleet_configuration,
    "${{ vars.LYRASHIELD_RUNTIME_FLEET_EVIDENCE }}"
  )
  assert.equal(release.jobs["qualify-runtime"].with.runtime_fleet_evidence, undefined)
  const job = issuer.jobs["verify-signing-boundary"]
  assert.equal(job.environment, "release-qualification")
  const witness = job.steps.findIndex((step) => step.id === "evidence-witnesses")
  const locate = job.steps.findIndex((step) => step.id === "evidence-selectors")
  const signing = job.steps.findIndex((step) => step.id === "fleet")
  assert.ok(witness >= 0 && witness < locate && locate < signing)
  for (const name of Object.keys(records)) {
    const index = job.steps.findIndex((step) => step.id === `${name}-witness`)
    assert.ok(witness < index && index < locate)
    const step = job.steps[index]
    assert.equal(step.if, "inputs.runtime_fleet_configuration != ''")
    assert.equal(step.with.name, `\${{ steps.evidence-witnesses.outputs.${name}_artifact_name }}`)
    assert.equal(
      step.with.path,
      `\${{ runner.temp }}/lyrashield-runtime-evidence-witnesses/${name}/paired-witness.json`
    )
    assert.equal(step.with["if-no-files-found"], "error")
    assert.equal(
      job.steps[locate].env[`${name.toUpperCase()}_ARTIFACT_ID`],
      `\${{ steps.${name}-witness.outputs.artifact-id }}`
    )
  }
  assert.equal(
    job.steps[locate].env.RUNTIME_FLEET_CONFIGURATION,
    "${{ inputs.runtime_fleet_configuration }}"
  )
  assert.equal(job.steps[locate].env.PREPARED_RUNTIME_FLEET, "${{ inputs.prepared_fleet }}")
  assert.equal(
    job.steps[signing].env.RUNTIME_FLEET_EVIDENCE,
    "${{ steps.evidence-selectors.outputs.runtime_fleet_evidence || inputs.runtime_fleet_evidence }}"
  )
})

test("refuses unowned filesystem exports and never reads a caller-supplied leaf", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lyrashield-unowned-evidence-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated test fixture
  writeFileSync(join(directory, "native.json"), raw["native.json"])
  assert.throws(() => readRootObservedRuntimeRecord(directory, "native.json"))
  assert.throws(() => readRootObservedRuntimeRecord(directory, "../native.json"))
})

test(
  "actual Linux root reader rejects writable, aliased and malformed producer files",
  {
    skip: process.platform !== "linux" || process.getuid() !== 0,
  },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "lyrashield-root-evidence-"))
    t.after(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- restore test-owned directory for cleanup
      chmodSync(directory, 0o755)
      rmSync(directory, { recursive: true, force: true })
    })
    const file = join(directory, "native.json")
    // All filesystem operations below use this isolated root-owned test directory.
    /* eslint-disable security/detect-non-literal-fs-filename */
    writeFileSync(file, raw["native.json"], { mode: 0o444 })
    chmodSync(directory, 0o555)
    assert.equal(readRootObservedRuntimeRecord(directory, "native.json"), raw["native.json"])
    chmodSync(file, 0o644)
    assert.throws(() => readRootObservedRuntimeRecord(directory, "native.json"))
    chmodSync(file, 0o444)
    chmodSync(directory, 0o755)
    linkSync(file, join(directory, "linked.json"))
    chmodSync(directory, 0o555)
    assert.throws(() => readRootObservedRuntimeRecord(directory, "native.json"))
    chmodSync(directory, 0o755)
    unlinkSync(join(directory, "linked.json"))
    unlinkSync(file)
    symlinkSync("linked.json", file)
    chmodSync(directory, 0o555)
    assert.throws(() => readRootObservedRuntimeRecord(directory, "native.json"))
    chmodSync(directory, 0o755)
    unlinkSync(file)
    writeFileSync(file, Buffer.from([0xc3, 0x28]), { mode: 0o444 })
    chmodSync(directory, 0o555)
    assert.throws(() => readRootObservedRuntimeRecord(directory, "native.json"))
    chmodSync(directory, 0o755)
    unlinkSync(file)
    writeFileSync(file, "x".repeat(4097), { mode: 0o444 })
    chmodSync(directory, 0o555)
    assert.throws(() => readRootObservedRuntimeRecord(directory, "native.json"))
    /* eslint-enable security/detect-non-literal-fs-filename */
  }
)
