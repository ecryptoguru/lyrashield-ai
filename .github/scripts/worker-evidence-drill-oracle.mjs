// Expectations come from authenticated input bytes, independent of the product output.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

export const ws = "drill-private-workspace"
export const targetId = "drill-repo"
export const bucket = "disposable-evidence"
export const hash = (data) => createHash("sha256").update(data).digest("hex")
const sorted = (values) => [...values].sort()

function checkedFixtures(kind, root) {
  const helper = fileURLToPath(new URL("./worker-evidence-fixture-io.py", import.meta.url))
  const result = execFileSync("python3", ["-I", "-B", helper, kind, root], {
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  })
  return JSON.parse(result)
}
export function readWriterFixtures(root) {
  return checkedFixtures("writer", root)
}
export function distinctFixture(root) {
  return checkedFixtures("distinct", root)[0]
}

// New, launch-compatible, synthetic legacy controls. They are not writer outputs.
// The original 1.0/1.1 repository goldens intentionally have unequal run_id/run_name.
export function legacy(version) {
  const id = "drill-legacy-" + version
  const run = { schema_version: version, run_id: id, run_name: id, status: "completed" }
  const vuln = {
    id: "legacy-finding",
    title: "Legacy " + version + " fixture",
    severity: "medium",
    description: "Disposable compatibility observation",
    timestamp: "2026-09-10 10:02:31 UTC",
    evidence: "Fixture only",
    ...(version === "1.1"
      ? { evidence_contract_version: "1.1", counterevidence: "Unverified fixture" }
      : {}),
  }
  return {
    name: id,
    id,
    bytes: { "run.json": JSON.stringify(run), "vulnerabilities.json": JSON.stringify([vuln]) },
    row: { status: "legacy", ordinary: {}, pending: {} },
  }
}

// This oracle reads the already authenticated input buffers. No expectation is taken
// from the parser, normalized winner, database row or content-addressed object under test.
function fixtureExpectation(f) {
  const run = JSON.parse(f.bytes["run.json"])
  const source = JSON.parse(f.bytes["vulnerabilities.json"])
  const positive = ["exported", "partial"].includes(f.row.status)
  const owners = new Map(
    source.map((v) => [
      v.id,
      {
        id: v.id,
        pending: f.row.pending[v.id] ?? [],
        captured: positive ? f.row.ordinary[v.id] : [],
        revisions: v.update_history,
        updatedAt: v.updated_at,
        contract: v.evidence_contract_version,
        verification: v.verification_state,
      },
    ])
  )
  let document = null
  if (positive) {
    const raw = JSON.parse(f.bytes["http_exchanges.json"])
    const { targets: _excluded, ...binding } = raw.binding
    const ids = new Set([...owners.values()].flatMap((v) => v.captured))
    const exchanges = raw.exchanges.filter((e) => ids.has(e.proxy_request_id))
    assert.deepEqual(sorted(exchanges.map((e) => e.proxy_request_id)), sorted(ids))
    assert.equal(binding.run_id, f.id)
    assert.equal(binding.run_name, f.id)
    assert.equal(binding.report_artifacts_revision, run.report_artifacts_revision)
    for (const v of owners.values())
      assert.equal(binding.finding_revisions[v.id], v.revisions?.length ?? 0)
    document = {
      schema_version: raw.schema_version,
      generated_at: raw.generated_at,
      binding,
      exchanges,
    }
    for (const key of ["missing_request_ids", "capacity_omitted_request_ids"]) {
      if (raw[key]?.length) document[key] = raw[key]
    }
    if (raw.truncated) document.truncated = raw.truncated
  }
  // These three exact fixture receipts contain equal-key, equal-rank owners. Only their first
  // owner survives normal product dedupe. Distinct-owners must retain both independently.
  const selected = ["shared-capacity", "max-bytes", "omission-limit"].includes(f.name)
    ? [source[0].id]
    : source.map((v) => v.id)
  return { owners, selected, document, version: run.schema_version }
}

function checkOwner(actual, expected, label) {
  assert.ok(expected, label + ": unexpected owner")
  assert.deepEqual(
    actual.pending_http_exchange_ids ?? [],
    expected.pending,
    label + ": pending IDs"
  )
  assert.deepEqual(actual.http_exchange_ids ?? [], expected.captured, label + ": captured IDs")
  assert.equal(actual.evidence_contract_version, expected.contract, label + ": authority")
  assert.equal(actual.engine_verification_state, expected.verification, label + ": verification")
  assert.deepEqual(actual.update_history, expected.revisions, label + ": revision history")
  assert.equal(actual.updated_at, expected.updatedAt, label + ": revision timestamp")
}

export function qualifyFixture(
  f,
  { parseEngineOutput, generateDedupeKey, normalizeFindings, filterFalsePositives }
) {
  const expected = fixtureExpectation(f)
  const output = parseEngineOutput(
    f.bytes["vulnerabilities.json"],
    f.bytes["run.json"],
    { httpExchangesRaw: f.bytes["http_exchanges.json"] },
    { expectedRunName: f.id }
  )
  assert.equal(output.runRecord?.schema_version, expected.version)
  const raw = output.vulnerabilities.map((v) => ({ ...v, scannerSource: "engine" }))
  assert.deepEqual(
    sorted(raw.map((v) => v.id)),
    sorted(expected.owners.keys()),
    "missing writer owner"
  )
  for (const v of raw) checkOwner(v, expected.owners.get(v.id), f.name + "/" + v.id)
  if (expected.document === null)
    assert.equal(output.httpExchangeExport, null, "unexpected HTTP capture artifact")
  else {
    assert.ok(output.httpExchangeExport, "missing required HTTP capture artifact")
    assert.deepEqual(
      JSON.parse(output.httpExchangeExport.document),
      expected.document,
      "foreign or incomplete capture provenance"
    )
    assert.equal(output.httpExchangeExport.exchangeCount, expected.document.exchanges.length)
  }
  const survivors = filterFalsePositives(normalizeFindings(raw, targetId, generateDedupeKey))
  assert.deepEqual(
    sorted(survivors.map((v) => v.id)),
    sorted(expected.selected),
    "wrong canonical owners"
  )
  for (const v of survivors)
    checkOwner(v, expected.owners.get(v.id), "changed winning owner's " + v.id)
  return {
    output,
    survivors,
    discarded: raw.filter((v) => !expected.selected.includes(v.id)),
    expected,
  }
}

export function checkStoredObservation(content, owner, scanId, findingId, exportHash) {
  assert.equal(content.evidenceContractVersion, owner.contract)
  assert.equal(content.engineVerificationState, owner.verification)
  assert.equal(content.updatedAt, owner.updatedAt)
  assert.equal(content.sourceScanId, scanId)
  assert.equal(content.sourceFindingId, findingId)
  assert.deepEqual(content.updateHistory, owner.revisions)
  assert.deepEqual(content.pendingHttpExchangeIds ?? [], owner.pending)
  assert.equal(content.pendingHttpExchangeState, owner.pending.length ? "PENDING" : undefined)
  assert.deepEqual(content.httpExchangeIds ?? [], owner.captured)
  assert.equal(content.httpExchangeArtifactChecksum, owner.captured.length ? exportHash : undefined)
}

export async function checkPersistedCase(
  f,
  { parse, owner, db, s3, ListObjectsV2Command, readEncryptedArtifact }
) {
  const { survivors, discarded, expected } = parse(f)
  const stored = await owner.scanResultManifest.findUniqueOrThrow({ where: { scanId: f.id } })
  assert.equal(db.verifyStoredManifestChecksum(stored), "MATCH")
  const evidence = stored.manifest.httpExchangeEvidence
  const rowReceipt = await owner.findingVerification.findMany({
    where: { scanId: f.id },
    orderBy: { id: "asc" },
  })
  assert.equal(rowReceipt.length, survivors.length)
  assert.equal(await owner.findingCandidate.count({ where: { scanId: f.id } }), survivors.length)
  const prefix = `evidence/${ws}/${f.id}/http_exchanges/`
  const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
  assert.ok(!objects.IsTruncated)
  const keys = (objects.Contents ?? []).map((o) => o.Key)
  if (expected.document) {
    assert.ok(evidence)
    assert.deepEqual(keys, [prefix + "http-exchanges-" + evidence.checksum])
    const read = await readEncryptedArtifact("s3://" + bucket + "/" + keys[0], ws)
    assert.equal(read.checksum, evidence.checksum)
    assert.equal(hash(read.content), evidence.checksum)
    assert.equal(read.content.length, evidence.byteLength)
    assert.equal(evidence.exchangeCount, expected.document.exchanges.length)
    assert.equal(read.legacy, false)
    assert.deepEqual(JSON.parse(read.content.toString()), expected.document)
  } else {
    assert.equal(evidence, undefined)
    assert.deepEqual(keys, [], "unexpected stored scan-level HTTP export")
  }
  const historical = []
  for (const winner of survivors) {
    const finding = await owner.finding.findUniqueOrThrow({
      where: {
        targetId_dedupeKey: {
          targetId,
          dedupeKey: winner.dedupeKey,
        },
      },
    })
    assert.equal(finding.verified, false)
    const rows = await owner.evidence.findMany({
      where: {
        findingId: finding.id,
        type: "claim_context",
        id: { startsWith: db.claimObservationPrefix(finding.id, f.id) },
      },
    })
    assert.equal(rows.length, 1)
    const claim = rows[0]
    const opened = await readEncryptedArtifact(claim.storageUri, ws)
    assert.equal(opened.checksum, claim.checksum)
    assert.equal(opened.encryptionKeyRef, claim.encryptionKeyRef)
    assert.equal(opened.legacy, false)
    const content = JSON.parse(opened.content.toString())
    const original = expected.owners.get(winner.id)
    checkStoredObservation(content, original, f.id, finding.id, evidence?.checksum)
    const { captured } = original
    const captureHash = captured.length ? evidence.checksum : undefined
    const candidate = await owner.findingCandidate.findFirstOrThrow({
      where: {
        scanId: f.id,
        dedupeKey: winner.dedupeKey,
        scannerSource: "engine",
      },
    })
    assert.equal(candidate.findingId, finding.id)
    assert.equal(candidate.payload.id, original.id)
    assert.deepEqual(candidate.payload.httpExchangeIds, captured)
    assert.ok(!Object.keys(candidate.payload).some((k) => /pending/i.test(k)))
    const vr = rowReceipt.find((v) => v.findingId === finding.id)
    assert.equal(vr.findingId, candidate.findingId)
    assert.equal(vr.candidateId, candidate.id)
    assert.equal(vr.status, "DETECTED")
    assert.equal(vr.method, "ENGINE_CLAIM")
    assert.deepEqual(vr.evidence.httpExchangeIds ?? [], captured)
    assert.equal(vr.evidence.httpExchangeArtifactChecksum, captureHash)
    assert.ok(!Object.keys(vr.evidence).some((k) => /pending/i.test(k)))
    historical.push({
      finding: finding.id,
      observation: claim.id,
      receipt: vr.id,
      checksum: opened.checksum,
    })
  }
  return {
    scanId: f.id,
    manifest: stored.checksum,
    writerInputHashes: f.row.files ?? null,
    revisions: expected.selected.map((id) => [id, expected.owners.get(id).revisions?.length ?? 0]),
    historical,
    discarded: discarded.map((v) => ({
      owner: v.id,
      pending: v.pending_http_exchange_ids ?? [],
      captured: v.http_exchange_ids ?? [],
    })),
  }
}

export async function readObjectIdentity({
  s3,
  ListObjectsV2Command,
  GetObjectCommand,
  verifyEnvelopeShape,
}) {
  const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket }))
  assert.ok(!objects.IsTruncated)
  const out = {}
  for (const { Key } of objects.Contents ?? []) {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }))
    assert.equal(object.ServerSideEncryption, "AES256")
    const encrypted = Buffer.from(await object.Body.transformToByteArray())
    assert.ok(verifyEnvelopeShape(encrypted), "object store must retain only sealed envelopes")
    out[Key] = hash(encrypted)
  }
  return out
}
