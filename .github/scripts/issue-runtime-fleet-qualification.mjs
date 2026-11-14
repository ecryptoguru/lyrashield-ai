// The protected release issuer constructs one exact-artifact qualification
// record from authenticated evidence. It accepts record selectors, never
// candidate bytes or signing payloads, and it never copies a digest into
// authority.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import {
  issueRecordWitness,
  readQualificationIssuerToken,
  verifiedArtifact,
  verifyCurrentSource,
} from "./paired-runtime-github.mjs"
import { verifyIndependentSandboxInventory } from "./independent-sandbox-inventory.mjs"
import { validateQualifiedFleetArchive } from "./paired-runtime-qualification.mjs"
import { verifyImageSources } from "./paired-runtime-cloud.mjs"
import { requirePreparedRuntimeFleet } from "./prepared-runtime-fleet.mjs"
import { canonicalJson } from "../../packages/runtime-control/src/canonical-json.ts"
import {
  runtimeQualificationKeyId,
  verifyRuntimeQualificationSignature,
} from "../../packages/security/src/sandbox-publication-record.ts"

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const { z } = require("zod")
const issuerWorkflow = ".github/workflows/issue-runtime-qualification.yml"
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  revision = z.string().regex(/^[a-f0-9]{40}$/)
const image = z.string().regex(/^sha256:[a-f0-9]{64}$/),
  owner = z.string().regex(/^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/)
export const runtimeFleetChecks = Object.freeze([
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
])
const fleetSchema = z
  .object({
    productRevision: revision,
    engineRevision: revision,
    webDigest: image,
    proxyDigest: image,
    workerDigest: image,
    sandboxDigest: image,
    brokerDigest: image,
    supervisorDigest: image,
    providerGatewayDigest: image,
    migrationChecksum: image,
    runtimePolicyDigest: image,
  })
  .strict()
const header = { kind: z.literal("evidence"), owner, source: revision, fleetSha256: sha }
const nativeSchema = z
  .object({
    ...header,
    schema: z.literal("lyrashield-runtime-fleet-acceptance/1"),
    scope: z.literal("disposable-linux"),
    sourceTree: revision,
    fleet: fleetSchema,
    architecture: z.enum(["amd64", "arm64"]),
    checks: z
      .object(
        Object.fromEntries(
          runtimeFleetChecks.map((name) => [
            name,
            z.object({ state: z.literal("PASSED"), receiptSha256: sha }).strict(),
          ])
        )
      )
      .strict(),
  })
  .strict()
const migrationSchema = z
  .object({
    ...header,
    schema: z.literal("lyrashield-runtime-migration-evidence/1"),
    migrationChecksum: image,
    schemaProofSha256: sha,
    baselineMigrationChecksum: image,
    additiveCompatibilityProofSha256: sha,
  })
  .strict()
const policySchema = z
  .object({
    ...header,
    schema: z.literal("lyrashield-runtime-policy-evidence/1"),
    runtimePolicyDigest: image,
    restrictedIdentitiesProofSha256: sha,
    executionDescriptorProofSha256: sha,
    privateControlProofSha256: sha,
  })
  .strict()
const journalSchema = z
  .object({
    ...header,
    schema: z.literal("lyrashield-runtime-journal-evidence/1"),
    sealSchema: z.literal("lyrashield-journal-seal/2"),
    sealHash: sha,
    recoverySnapshotSha256: sha,
    pinEnvelopeHash: sha,
    observedControlCasAckHash: sha,
    observedJournalAckHash: sha,
    observedSealAckHash: sha,
    postgresHeadHash: sha,
    r2HeadHash: sha,
    sequence: z.number().int().positive().safe(),
  })
  .strict()
const selectorSchema = z
  .object({
    native: sha,
    migration: sha,
    policy: sha,
    journal: sha,
    rollback: sha,
    inventory: z
      .object({
        sandboxDigest: image,
        engineRevision: revision,
        publicationRevision: revision,
        publishRunId: z.string().regex(/^[1-9][0-9]{0,19}$/),
        publishAttempt: z.string().regex(/^[1-9][0-9]{0,9}$/),
        verifierRevision: revision,
        verifierRunId: z.string().regex(/^[1-9][0-9]{0,19}$/),
        verifierAttempt: z.string().regex(/^[1-9][0-9]{0,9}$/),
      })
      .strict(),
  })
  .strict()
const configuration = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- source-owned public signer configuration
  readFileSync(new URL("../qualification-issuer-key.json", import.meta.url), "utf8")
)
assert.equal(configuration.keyId, runtimeQualificationKeyId)
const hash = (raw) => createHash("sha256").update(raw).digest("hex")

function azure(args) {
  try {
    const raw = execFileSync("az", [...args, "--only-show-errors", "--output", "json"], {
      timeout: 30000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return raw.length ? JSON.parse(raw) : null
  } catch {
    // Azure errors can carry authentication material; never forward them.
    throw new Error("Protected fleet signing unavailable")
  }
}

function sourceTree() {
  return execFileSync("git", ["--no-replace-objects", "rev-parse", "HEAD^{tree}"], {
    timeout: 10000,
    maxBuffer: 256,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim()
}

// Control-plane images are separate from the web/worker pair and are pinned by
// their exact OCI revision label.
function verifyControllerImages(fleet) {
  for (const [field, name] of [
    ["brokerDigest", "broker"],
    ["supervisorDigest", "supervisor"],
    ["providerGatewayDigest", "provider-gateway"],
  ]) {
    const ref = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-${name}@${fleet[field]}`
    const raw = execFileSync(
      "docker",
      ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Image}}"],
      { timeout: 30000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }
    )
    const parsed = JSON.parse(raw),
      configs = parsed?.config ? [parsed] : Object.values(parsed || {})
    assert.ok(configs.length > 0 && configs.length <= 2)
    for (const config of configs) {
      assert.equal(config.os, "linux")
      assert.ok(["amd64", "arm64"].includes(config.architecture))
      assert.equal(
        config.config?.Labels?.["org.opencontainers.image.revision"],
        fleet.productRevision
      )
      assert.equal(
        config.config?.Labels?.["org.opencontainers.image.source"],
        "https://github.com/ecryptoguru/lyrashield-ai"
      )
    }
  }
}

/** Test seams are explicit trusted program dependencies; live defaults are the actual readers. */
// Authenticated evidence artifacts are hash-addressed and owner/source bound.
// The fleet hash cross-binds every supporting record to the same fleet.
async function evidenceArtifact(deps, id, schema, identity, fleetHash) {
  const artifact = await deps.readArtifact("evidence", id)
  assert.equal(hash(artifact.raw), id)
  assert.ok(Buffer.byteLength(artifact.raw) <= 4096)
  const parsed = schema.parse(JSON.parse(artifact.raw))
  assert.equal(parsed.owner, artifact.owner)
  assert.equal(parsed.owner, identity.owner)
  assert.equal(parsed.source, artifact.source)
  assert.equal(parsed.source, identity.source)
  if (fleetHash) assert.equal(parsed.fleetSha256, fleetHash)
  return parsed
}

// The rollback pair must be a different, qualified artifact set than the fleet
// being issued, so recovery can never restore the same bytes.
async function qualifiedRollbackArtifact(deps, selectorRollback, fleet, migration) {
  const archived = await deps.readArtifact("qualified-fleet", selectorRollback)
  assert.equal(hash(archived.raw), selectorRollback)
  const rollback = JSON.parse(archived.raw)
  validateQualifiedFleetArchive(rollback)
  assert.equal(rollback.pair.owner, archived.owner)
  assert.equal(rollback.pair.productRevision, archived.source)
  assert.equal(rollback.pair.engineRevision, fleet.engineRevision)
  assert.equal(rollback.controlPlane.migrationChecksum, migration.baselineMigrationChecksum)
  assert.notEqual(rollback.pair.workerDigest, fleet.workerDigest)
  await deps.verifyImages(rollback.pair)
  await deps.verifyControllers({ ...rollback.pair, ...rollback.controlPlane })
  return rollback
}

// Builds the canonical record from authenticated evidence only. Every
// assertion here is a provenance or identity binding; nothing is defaulted.
function buildRecord({
  selector,
  authenticated,
  source,
  native,
  fleet,
  fleetHash,
  journal,
  migration,
  policy,
  inventory,
  rollback,
  clock,
}) {
  const [runId, attempt] = source.owner.split(":")
  return {
    kind: "runtime-fleet-qualification",
    schema: "lyrashield-runtime-fleet-qualification/1",
    purpose: "exact-artifact-release",
    scope: "disposable-linux",
    fleet,
    sourceTree: native.sourceTree,
    architecture: native.architecture,
    evidence: {
      native: selector.native,
      migration: selector.migration,
      policy: selector.policy,
      journal: selector.journal,
      rollback: selector.rollback,
      inventory: hash(canonicalJson(inventory)),
    },
    journal: {
      sealHash: journal.sealHash,
      recoverySnapshotSha256: journal.recoverySnapshotSha256,
      pinEnvelopeHash: journal.pinEnvelopeHash,
      observedControlCasAckHash: journal.observedControlCasAckHash,
    },
    issuer: {
      repositoryId: "1286618458",
      repositoryOwnerId: "116722580",
      workflow: issuerWorkflow,
      source: source.source,
      runId,
      attempt,
    },
    issuedAt: Math.floor(clock() / 1000),
  }
}

export function createProtectedRuntimeFleetIssuer({
  preparedFleet,
  readIdentity = readQualificationIssuerToken,
  readSource = verifyCurrentSource,
  readArtifact = (kind, digest) => verifiedArtifact(kind, digest, issuerWorkflow),
  verifyInventory = verifyIndependentSandboxInventory,
  verifyImages = verifyImageSources,
  verifyControllers = verifyControllerImages,
  tree = sourceTree,
  run = azure,
  verifySignature = verifyRuntimeQualificationSignature,
  witness = issueRecordWitness,
  clock = Date.now,
} = {}) {
  const deps = Object.freeze({
    readIdentity,
    readSource,
    readArtifact,
    verifyInventory,
    verifyImages,
    verifyControllers,
    tree,
    run,
    verifySignature,
    witness,
    clock,
  })
  const evidence = (id, schema, identity, fleetHash) =>
    evidenceArtifact(deps, id, schema, identity, fleetHash)
  const qualifiedRollback = (selectorRollback, fleet, migration) =>
    qualifiedRollbackArtifact(deps, selectorRollback, fleet, migration)

  // Signs only bytes this process constructed. The remote signer never sees a
  // caller-supplied digest, and the returned signature is verified in place.
  async function signRecord(raw, refreshedToken) {
    try {
      run([
        "login",
        "--service-principal",
        "--username",
        configuration.clientId,
        "--tenant",
        configuration.tenantId,
        "--federated-token",
        refreshedToken,
        "--allow-no-subscriptions",
      ])
      const result = run([
        "keyvault",
        "key",
        "sign",
        "--id",
        runtimeQualificationKeyId,
        "--algorithm",
        "RS256",
        "--digest",
        createHash("sha256").update(raw).digest("base64"),
      ])
      verifySignature(raw, result)
      return result
    } finally {
      run(["logout"])
    }
  }

  return Object.freeze({
    async issue(input) {
      const selector = selectorSchema.parse(input)
      const authenticated = await readIdentity(),
        source = await readSource()
      assert.equal(authenticated.identity.source, source.source)
      assert.equal(authenticated.identity.owner, source.owner)
      const native = await evidence(selector.native, nativeSchema, authenticated.identity)
      const fleet = native.fleet,
        fleetHash = hash(canonicalJson(fleet))
      assert.equal(native.fleetSha256, fleetHash)
      assert.equal(fleet.productRevision, source.source)
      requirePreparedRuntimeFleet(fleet, preparedFleet, authenticated.identity)
      assert.equal(native.sourceTree, tree())

      // Authenticated evidence is cross-bound to the same fleet before any
      // further read; a mismatch is an integrity failure, not a retry.
      const [migration, policy, journal] = await Promise.all([
        evidence(selector.migration, migrationSchema, authenticated.identity, fleetHash),
        evidence(selector.policy, policySchema, authenticated.identity, fleetHash),
        evidence(selector.journal, journalSchema, authenticated.identity, fleetHash),
      ])
      assert.equal(migration.migrationChecksum, fleet.migrationChecksum)
      assert.equal(policy.runtimePolicyDigest, fleet.runtimePolicyDigest)
      assert.equal(journal.postgresHeadHash, journal.r2HeadHash)

      const inventory = await verifyInventory(selector.inventory)
      // The independent inventory must stay non-authoritative: it proves what
      // was observed, never that runtime authority was installed.
      assert.equal(inventory.qualified, false)
      assert.equal(inventory.nativeInventoryRechecked, true)
      assert.equal(inventory.runtimeAuthorityVerified, false)
      assert.equal(inventory.sandboxDigest, fleet.sandboxDigest)
      assert.equal(inventory.engineRevision, fleet.engineRevision)
      await verifyImages(fleet)
      await verifyControllers(fleet)

      const rollback = await qualifiedRollback(selector.rollback, fleet, migration)

      const refreshed = await readIdentity()
      assert.equal(refreshed.identity.owner, authenticated.identity.owner)
      assert.equal(refreshed.identity.source, source.source)
      const raw = canonicalJson(
        buildRecord({
          selector,
          authenticated,
          source,
          native,
          fleet,
          fleetHash,
          journal,
          migration,
          policy,
          inventory,
          rollback,
          clock,
        })
      )
      assert.ok(Buffer.byteLength(raw) <= 4096)
      const result = await signRecord(raw, refreshed.token)
      const recordWitness = await witness("runtime-fleet-qualification", raw, issuerWorkflow)
      const record = JSON.parse(raw)
      return Object.freeze({
        envelope: Object.freeze({ raw, result }),
        witness: recordWitness,
        receipt: {
          schema: "lyrashield-runtime-fleet-issuance-receipt/1",
          source: source.source,
          owner: source.owner,
          fleet,
          evidence: record.evidence,
          qualificationSha256: hash(raw),
          scope: record.scope,
          issuedAt: record.issuedAt,
        },
      })
    },
  })
}

export function issueRuntimeFleetQualification() {
  assert.equal(arguments.length, 0, "Production issuer accepts no signing payload")
  const selector = process.env.RUNTIME_FLEET_EVIDENCE
  assert.ok(
    typeof selector === "string" && selector.length > 0 && Buffer.byteLength(selector) <= 4096,
    "Authenticated native fleet evidence selectors unavailable"
  )
  const prepared = process.env.PREPARED_RUNTIME_FLEET
  assert.ok(
    typeof prepared === "string" && prepared.length > 0 && Buffer.byteLength(prepared) <= 4096,
    "Same-run prepared runtime fleet unavailable"
  )
  return createProtectedRuntimeFleetIssuer({ preparedFleet: JSON.parse(prepared) }).issue(
    JSON.parse(selector)
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const issued = await issueRuntimeFleetQualification()
    const envelope = JSON.stringify(issued.envelope)
    for (const [path, body] of [
      ["runtime-fleet-qualification.json", envelope],
      ["runtime-fleet-qualification-receipt.json", JSON.stringify(issued.receipt)],
      ["paired-witness.json", issued.witness],
    ])
      writeFileSync(path, body + "\n", { mode: 0o600, flag: "wx" })
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        "runtime_fleet_qualification=" +
          envelope +
          "\nruntime_fleet_record_sha256=" +
          issued.receipt.qualificationSha256 +
          "\n"
      )
    process.stdout.write(
      "Authenticated exact-artifact fleet qualification issued. Installed production acceptance remains separate.\n"
    )
  } catch {
    process.stderr.write(
      "Protected runtime fleet qualification unavailable. No deployment authority issued.\n"
    )
    process.exitCode = 1
  }
}
