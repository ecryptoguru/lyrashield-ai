// Transport immutable native-producer records; never construct acceptance facts.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  issueRecordWitness,
  readQualificationIssuerToken,
  verifiedArtifact,
} from "./paired-runtime-github.mjs"
import { readPrivateRecord } from "./private-record.mjs"
import {
  validateHeldBaselineArchive,
  validateQualifiedFleetArchive,
} from "./paired-runtime-qualification.mjs"
import {
  runtimeFleetEvidenceConfigurationSchema,
  runtimeFleetEvidenceSchemas,
  validateRuntimeFleetEvidence,
} from "./issue-runtime-fleet-qualification.mjs"

const workflow = ".github/workflows/issue-runtime-qualification.yml"
const names = Object.keys(runtimeFleetEvidenceSchemas)
const hash = (raw) => createHash("sha256").update(raw).digest("hex")
const id = /^[1-9][0-9]{0,19}$/

export function readRootObservedRuntimeRecord(directory, name) {
  assert.equal(process.platform, "linux")
  assert.ok(
    [...names.map((item) => `${item}.json`), "rollback.json", "rollback.locator.json"].includes(
      name
    )
  )
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed native export directory, no-follow descriptor
  const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let file
  try {
    const parent = fstatSync(dir)
    assert.ok(parent.isDirectory() && parent.uid === 0 && (parent.mode & 0o222) === 0)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated leaf below the held directory descriptor
    file = openSync(
      `/proc/self/fd/${dir}/${name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    const before = fstatSync(file)
    assert.ok(
      before.isFile() &&
        before.uid === 0 &&
        before.nlink === 1 &&
        before.dev === parent.dev &&
        (before.mode & 0o222) === 0 &&
        before.size > 0 &&
        before.size <= 4096
    )
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(file, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    const after = fstatSync(file)
    assert.ok(
      length === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs &&
        after.uid === 0 &&
        after.nlink === 1 &&
        (after.mode & 0o222) === 0
    )
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, length)
    )
  } finally {
    if (file !== undefined) closeSync(file)
    closeSync(dir)
  }
}

function privateDirectory(directory) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed runner-owned output directory
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (error.code !== "EEXIST") throw error
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same fixed output directory
  const info = lstatSync(directory)
  assert.ok(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0)
}

function writePrivate(directory, name, raw) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked private directory and internal fixed/hash names
  writeFileSync(join(directory, name), raw, { flag: "wx", mode: 0o600 })
}

export function createRuntimeFleetEvidenceTransport({
  readIdentity = readQualificationIssuerToken,
  readObserved = readRootObservedRuntimeRecord,
  witness = issueRecordWitness,
  verifyArtifact = verifiedArtifact,
} = {}) {
  return {
    async witness({
      observedDirectory,
      recordDirectory,
      witnessDirectory,
      prepared,
      configuration,
    }) {
      const config = runtimeFleetEvidenceConfigurationSchema.parse(configuration)
      const raw = Object.fromEntries(
        names.map((name) => [name, readObserved(observedDirectory, `${name}.json`)])
      )
      for (const value of Object.values(raw)) assert.ok(Buffer.byteLength(value) <= 4096)
      const authenticated = await readIdentity()
      const records = validateRuntimeFleetEvidence(
        Object.fromEntries(names.map((name) => [name, JSON.parse(raw[name])])),
        authenticated.identity,
        prepared
      )
      assert.equal(config.inventory.sandboxDigest, records.native.fleet.sandboxDigest)
      assert.equal(config.inventory.engineRevision, records.native.fleet.engineRevision)
      const rollbackRaw = readObserved(observedDirectory, "rollback.json")
      assert.equal(hash(rollbackRaw), config.rollback)
      const rollback = JSON.parse(rollbackRaw)
      if (config.rollbackKind === "held-baseline") validateHeldBaselineArchive(rollback)
      else validateQualifiedFleetArchive(rollback)
      assert.notEqual(rollback.pair.workerDigest, records.native.fleet.workerDigest)
      const locatorRaw = readObserved(observedDirectory, "rollback.locator.json")
      const locator = JSON.parse(locatorRaw)
      assert.deepEqual(Object.keys(locator).sort(), ["artifactId", "attempt", "runId", "source"])
      for (const field of ["artifactId", "attempt", "runId"]) assert.match(locator[field], id)
      assert.equal(`${locator.runId}:${locator.attempt}`, rollback.pair.owner)
      assert.equal(locator.source, rollback.pair.productRevision)

      privateDirectory(recordDirectory)
      privateDirectory(witnessDirectory)
      writePrivate(recordDirectory, "runtime-evidence-configuration.json", JSON.stringify(config))
      writePrivate(recordDirectory, "runtime-evidence-prepared.json", JSON.stringify(prepared))
      writePrivate(recordDirectory, `${config.rollback}.json`, rollbackRaw)
      writePrivate(recordDirectory, `${config.rollback}.locator.json`, locatorRaw)
      const [runId, attempt] = authenticated.identity.owner.split(":")
      const output = {}
      for (const name of names) {
        const digest = hash(raw[name])
        const directory = join(witnessDirectory, name)
        privateDirectory(directory)
        const witnessed = await witness("evidence", raw[name], workflow)
        writePrivate(directory, "paired-witness.json", witnessed)
        writePrivate(recordDirectory, `${digest}.json`, raw[name])
        output[`${name}_digest`] = digest
        output[`${name}_artifact_name`] = `paired-v1-${runId}-${attempt}-evidence-${digest}`
      }
      return output
    },
    async locate({ recordDirectory, digests, artifactIds, prepared, configuration }) {
      assert.deepEqual(Object.keys(digests).sort(), [...names].sort())
      assert.deepEqual(Object.keys(artifactIds).sort(), [...names].sort())
      const config = runtimeFleetEvidenceConfigurationSchema.parse(
        JSON.parse(readPrivateRecord(recordDirectory, "runtime-evidence-configuration.json"))
      )
      const savedPrepared = JSON.parse(
        readPrivateRecord(recordDirectory, "runtime-evidence-prepared.json")
      )
      assert.deepEqual(config, runtimeFleetEvidenceConfigurationSchema.parse(configuration))
      assert.deepEqual(savedPrepared, prepared)
      const authenticated = await readIdentity()
      const raw = {}
      for (const name of names) {
        assert.match(digests[name], /^[a-f0-9]{64}$/)
        assert.match(artifactIds[name], id)
        raw[name] = readPrivateRecord(recordDirectory, `${digests[name]}.json`)
        assert.equal(hash(raw[name]), digests[name])
      }
      validateRuntimeFleetEvidence(
        Object.fromEntries(names.map((name) => [name, JSON.parse(raw[name])])),
        authenticated.identity,
        prepared
      )
      const [runId, attempt] = authenticated.identity.owner.split(":")
      for (const name of names) {
        writePrivate(
          recordDirectory,
          `${digests[name]}.locator.json`,
          JSON.stringify({
            runId,
            attempt,
            artifactId: artifactIds[name],
            source: authenticated.identity.source,
          })
        )
        const artifact = await verifyArtifact("evidence", digests[name], workflow)
        assert.equal(artifact.raw, raw[name])
        assert.equal(artifact.owner, authenticated.identity.owner)
        assert.equal(artifact.source, authenticated.identity.source)
        assert.equal(artifact.artifactId, artifactIds[name])
      }
      await verifyArtifact(config.rollbackKind ?? "qualified-fleet", config.rollback, workflow)
      return { ...digests, ...config }
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const temp = process.env.RUNNER_TEMP
    assert.ok(temp?.startsWith("/"))
    const recordDirectory = join(temp, "lyrashield-paired-records")
    const transport = createRuntimeFleetEvidenceTransport()
    for (const field of ["PREPARED_RUNTIME_FLEET", "RUNTIME_FLEET_CONFIGURATION"]) {
      assert.ok(process.env[field]?.length > 0 && Buffer.byteLength(process.env[field]) <= 4096)
    }
    const prepared = JSON.parse(process.env.PREPARED_RUNTIME_FLEET)
    const configuration = JSON.parse(process.env.RUNTIME_FLEET_CONFIGURATION)
    let output
    if (process.argv[2] === "witness") {
      output = await transport.witness({
        observedDirectory: join(temp, "lyrashield-runtime-fleet-evidence"),
        recordDirectory,
        witnessDirectory: join(temp, "lyrashield-runtime-evidence-witnesses"),
        prepared,
        configuration,
      })
    } else {
      assert.equal(process.argv[2], "locate")
      const selectors = await transport.locate({
        recordDirectory,
        prepared,
        configuration,
        digests: Object.fromEntries(
          names.map((name) => [name, process.env[`${name.toUpperCase()}_DIGEST`]])
        ),
        artifactIds: Object.fromEntries(
          names.map((name) => [name, process.env[`${name.toUpperCase()}_ARTIFACT_ID`]])
        ),
      })
      output = { runtime_fleet_evidence: JSON.stringify(selectors) }
    }
    assert.ok(process.env.GITHUB_OUTPUT)
    for (const [name, value] of Object.entries(output)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Actions-supplied output file; values are validated hashes/IDs
      appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
    }
  } catch {
    process.stderr.write("Observed runtime evidence transport unavailable; release remains held.\n")
    process.exitCode = 1
  }
}
