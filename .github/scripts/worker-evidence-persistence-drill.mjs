// Mounted alongside the exact worker's src and production dependencies, via its tsx binary.
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const summaryHash = "9f35f1e046f8a2a23f29a13a2ea6900d5d81a299806a67d99511bd5f438f663b"
const revision = "ed84ce06889e6a9c047db220fcabfa0c643200ad"
const workerDigest = "sha256:0c91d2a9dd91cfaa9a35ed9742aa118015a5deba8af324c1996d95d050442d5d"
const engineRevision = "3001517530300ca5f602536bfadcbd3c95ad3039"
const ws = "drill-private-workspace",
  user = "drill-owner",
  targetId = "drill-repo"
const mixed = "reverse-reuse",
  capture = "header-bound"
const hash = (data) => createHash("sha256").update(data).digest("hex")
const sorted = (values) => [...values].sort()
const bucket = "disposable-evidence"

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

export function requireDisposable(env, phase) {
  assert.equal(env.LYRASHIELD_TEST_DB_DISPOSABLE, "1")
  assert.equal(env.NODE_ENV, "test")
  assert.equal(env.LYRASHIELD_PRODUCT_REVISION, revision)
  assert.equal(env.LYRASHIELD_WORKER_IMAGE_DIGEST, workerDigest)
  assert.equal(env.LYRASHIELD_ENGINE_REVISION, engineRevision)
  assert.equal(env.LYRASHIELD_ENGINE_PATH, "/fixture-bin/drill-engine-denied")
  for (const [name, value] of Object.entries({
    DATABASE_URL: "postgresql://app_runtime_ci:runtime-ci-only@postgres:5432/lyrashield",
    DATABASE_DIRECT_URL: "postgresql://lyrashield:disposable-only@postgres:5432/lyrashield",
    DATABASE_SYSTEM_URL: "postgresql://lyrashield:disposable-only@postgres:5432/lyrashield",
    REDIS_URL: "redis://redis:6379",
    S3_ENDPOINT: "http://s3:9000",
    S3_BUCKET: phase === "denied" ? "deliberately-absent" : bucket,
    S3_ACCESS_KEY: "fixture-access-only",
    S3_SECRET_KEY: "fixture-secret-only",
  }))
    assert.equal(env[name], value, "refusing non-disposable " + name)
  assert.notEqual(env.LYRASHIELD_LOCAL_EVIDENCE_STORAGE, "1")
  assert.ok(!env.DOCKER_HOST && !env.GITHUB_TOKEN && !env.GH_TOKEN)
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

export async function requireLiveLock(redis, queue, jobId, token) {
  assert.ok(redis, "disposable Redis required")
  assert.ok(
    token && (await redis.get(queue.toKey(jobId + ":lock"))) === token,
    "worker must own the live lock"
  )
}

export async function requireCrashedJob(queue, original) {
  const old = await queue.getJob(original.id)
  assert.ok(old, "interrupted job disappeared")
  assert.equal(await old.getState(), "active")
  assert.equal(old.timestamp, original.timestamp)
  assert.equal(old.data.drillNonce, original.nonce)
  assert.equal(old.attemptsStarted, 1)
  assert.equal(old.stalledCounter, 0)
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

export function assertRecoveredDelivery(job, original) {
  assert.ok(
    original.id &&
      Number.isSafeInteger(original.timestamp) &&
      typeof original.nonce === "string" &&
      original.nonce.length
  )
  assert.equal(job.id, original.id)
  assert.equal(job.timestamp, original.timestamp)
  assert.equal(job.data.drillNonce, original.nonce)
  assert.equal(job.attemptsStarted, 2, "original job must actually be dispatched a second time")
  assert.equal(job.stalledCounter, 1, "BullMQ must recover the stalled original job")
}

function checkReaderSources() {
  const paths = [
    "src/engine/output-parser.ts",
    "src/engine/output-parser-evidence.ts",
    "src/engine/output-parser-artifacts.ts",
    "src/engine/output-parser-findings.ts",
    "src/engine/output-parser-run.ts",
    "src/engine/normalizer.ts",
    "src/engine/finding-persister.ts",
    "src/engine/evidence-storage.ts",
    "src/engine/result-integrity/detection-receipt.ts",
    "src/engine/result-integrity/result-manifest.ts",
    "src/jobs/run-scan/finalization.ts",
    "src/jobs/run-scan/pending-finalization.ts",
    "src/jobs/run-scan/http-exchange-evidence.ts",
    "src/queue-reconciliation.ts",
    "@lyrashield/evidence-storage",
  ]
  const source = paths
    .map((name) => {
      const path = name.startsWith("@") ? fileURLToPath(import.meta.resolve(name)) : resolve(name)
      return name + "\0" + hash(readFileSync(path)) + "\n"
    })
    .join("")
  assert.equal(
    hash(source),
    "ae1407d6bf00803854f6b536c25d3234093275d6f370e04206b9312c22084564",
    "image reader sources differ from ed84"
  )
}

async function main(phase) {
  requireDisposable(process.env, phase)
  checkReaderSources()
  const callsFile = "/proof/engine-called"
  const poison = createServer((_req, res) => {
    appendFileSync("/proof/provider-called", "attempt\n")
    res.writeHead(503)
    res.end()
  })
  await new Promise((ok, fail) => poison.once("error", fail).listen(0, "127.0.0.1", ok))
  const poisonURL = "http://127.0.0.1:" + poison.address().port
  for (const key of ["OPENAI_BASE_URL", "AZURE_OPENAI_ENDPOINT", "AZURE_AI_BASE_URL"])
    process.env[key] = poisonURL

  const db = await import("@lyrashield/db")
  const { PrismaClient } = await import("@lyrashield/db/src/generated/prisma")
  const { createBoundedPgAdapter } = await import("@lyrashield/db/src/pool")
  const owner = new PrismaClient({
    adapter: createBoundedPgAdapter(process.env.DATABASE_DIRECT_URL),
  })
  const integrations = await import("@lyrashield/integrations")
  const { readEncryptedArtifact, verifyEnvelopeShape } =
    await import("@lyrashield/evidence-storage")
  const sdkPath = createRequire(import.meta.resolve("@lyrashield/evidence-storage")).resolve(
    "@aws-sdk/client-s3"
  )
  const { S3Client, CreateBucketCommand, ListObjectsV2Command, GetObjectCommand } = createRequire(
    import.meta.url
  )(sdkPath)
  const s3 = new S3Client({
    region: "us-east-1",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
  })
  const { parseEngineOutput, generateDedupeKey } = await import("./src/engine/output-parser.ts")
  const { normalizeFindings, filterFalsePositives } = await import("./src/engine/normalizer.ts")
  const { finalizeScanLifecycle } = await import("./src/jobs/run-scan/finalization.ts")
  const { resolveWorkerExecutionProvenance } = await import("@lyrashield/config")
  const cases = [
    ...readWriterFixtures("/fixtures"),
    distinctFixture("/distinct"),
    legacy("1.0"),
    legacy("1.1"),
  ]
  const checkpoint = cases.find((f) => f.name === mixed)
  const header = cases.find((f) => f.name === capture)
  const target = {
    id: targetId,
    type: "REPO",
    repoFullName: "fixture/private",
    branch: "fixture",
    url: null,
  }
  const scoped = (fn) => db.runWithWorkspaceContext(ws, fn)
  const jobData = (scanId) => ({
    scanId,
    workspaceId: ws,
    targetId,
    goal: "TEST_APP",
    mode: "SAFE",
  })
  const seedScan = (id) =>
    owner.scan.create({
      data: {
        id,
        workspaceId: ws,
        targetId,
        createdById: user,
        status: "VERIFYING",
        goal: "TEST_APP",
        mode: "SAFE",
        startedAt: new Date(),
        actualCostCents: 0,
      },
    })

  const parse = (f) =>
    qualifyFixture(f, {
      parseEngineOutput,
      generateDedupeKey,
      normalizeFindings,
      filterFalsePositives,
    })

  async function persist(f) {
    const { output, survivors } = parse(f)
    await seedScan(f.id)
    // Test input only: a zero-cost completed finalization request. Writer run.status is untouched.
    const result = await scoped(() =>
      finalizeScanLifecycle({
        scanId: f.id,
        workspaceId: ws,
        targetId,
        target,
        grace: { assertRemaining() {} },
        engineResult: { output },
        orchestratorResult: {
          engineFindings: survivors,
          allFindings: survivors,
          coverageIssues: [],
        },
        coverageMatchedControlRanks: [],
        routingCoverageIssue: null,
        engineBacked: true,
        budgetExceeded: false,
        billedCostUsd: 0,
        costReconciled: true,
        maxBudgetUsd: 0,
        workerExecution: resolveWorkerExecutionProvenance(),
        terminalErrorAfterMeter: () => null,
        meterEngineRun: async (outcome, seal) => {
          assert.equal(outcome, "completed")
          assert.ok(seal)
          await seal()
        },
        onDurableResult: (r) => assert.equal(r.status, "completed"),
      })
    )
    assert.equal(result.status, "finalized")
  }

  async function checkCase(f) {
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
      revisions: expected.selected.map((id) => [
        id,
        expected.owners.get(id).revisions?.length ?? 0,
      ]),
      historical,
      discarded: discarded.map((v) => ({
        owner: v.id,
        pending: v.pending_http_exchange_ids ?? [],
        captured: v.http_exchange_ids ?? [],
      })),
    }
  }

  async function objectIdentity() {
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

  const identityPath = "/proof/checkpoint-job.json"

  // The same automatic Worker manages the original lock, lock renewal, stall detection
  // and completion in all phases. Only the initial processor substitutes the synthetic
  // zero-cost finalizer for engine execution. Recovery uses the real processScanJob.
  async function runCheckpoint(mode) {
    const { Worker } = await import("bullmq")
    const { SCAN_QUEUE_NAME } = await import("@lyrashield/types")
    const { processScanJob } = await import("./src/jobs/run-scan.job.ts")
    const queue = integrations.getScanQueue()
    const recovered = mode === "recover"
    let original
    if (recovered) {
      original = JSON.parse(readFileSync(identityPath, "utf8"))
      assert.equal(original.id, checkpoint.id)
      await requireCrashedJob(queue, original)
    } else {
      // The original job is created only before the kill. Explicit terminal replay
      // is created only after the retained, recovered job is proved completed.
      assert.ok(!(await queue.getJob(checkpoint.id)))
      const nonce = randomUUID()
      const added = await queue.add(
        "scan",
        { ...jobData(checkpoint.id), drillNonce: nonce },
        { jobId: checkpoint.id, removeOnComplete: mode === "terminal" }
      )
      original = { id: added.id, timestamp: added.timestamp, nonce }
    }
    const stalledIds = []
    const worker = new Worker(
      SCAN_QUEUE_NAME,
      async (job, token) => {
        assert.equal(job.id, checkpoint.id)
        assert.equal(await job.getState(), "active")
        await requireLiveLock(integrations.getRedis(), queue, job.id, token)
        if (mode === "interrupt") {
          assert.equal(job.attemptsStarted, 1)
          assert.equal(job.stalledCounter, 0)
          writeFileSync(identityPath, JSON.stringify(original), { flag: "wx", mode: 0o644 })
          await persist(checkpoint)
          throw new Error("terminal barrier was bypassed")
        }
        if (recovered) assertRecoveredDelivery(job, original)
        else {
          assert.equal(job.attemptsStarted, 1)
          assert.equal(job.stalledCounter, 0)
        }
        const result = await processScanJob(job)
        assert.equal(result.status, "completed")
        return result
      },
      {
        connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
        autorun: false,
        concurrency: 1,
        lockDuration: 8000,
        stalledInterval: 1000,
        maxStalledCount: 1,
      }
    )
    worker.on("stalled", (id) => stalledIds.push(id))
    let timer
    try {
      await new Promise((ok, fail) => {
        timer = setTimeout(() => fail(new Error("checkpoint delivery timed out: " + mode)), 75000)
        worker.once("completed", ok)
        worker.once("failed", (_job, error) => fail(error))
        worker.once("error", fail)
        worker.run().catch(fail)
      })
      if (recovered) {
        assert.deepEqual(stalledIds, [checkpoint.id])
        const completed = await queue.getJob(checkpoint.id)
        assert.equal(await completed.getState(), "completed")
        assertRecoveredDelivery(completed, original)
        console.log(
          JSON.stringify({
            recoveredJob: original.id,
            timestamp: original.timestamp,
            attemptsStarted: completed.attemptsStarted,
            stalledCounter: completed.stalledCounter,
          })
        )
        await completed.remove()
      }
    } finally {
      clearTimeout(timer)
      await worker.close(true)
    }
  }

  try {
    if (phase === "init") {
      assert.equal(await owner.workspace.count(), 0, "fixture database must be empty")
      await owner.user.create({
        data: { id: user, name: "Fixture owner", email: "fixture@example.invalid" },
      })
      await owner.workspace.create({ data: { id: ws, name: "Disposable fixture", slug: ws } })
      await owner.workspaceMember.create({ data: { workspaceId: ws, userId: user, role: "OWNER" } })
      await owner.target.create({ data: { ...target, workspaceId: ws, name: "Fixture" } })
      await s3.send(new CreateBucketCommand({ Bucket: bucket }))
    } else if (phase === "denied") {
      await assert.rejects(() => persist(header), /Failed to store evidence/)
      for (const model of [
        "finding",
        "findingCandidate",
        "findingVerification",
        "scanResultManifest",
      ]) {
        assert.equal(await owner[model].count({ where: { scanId: header.id } }), 0)
      }
      assert.equal(await owner.evidence.count(), 0)
      await owner.scan.delete({ where: { id: header.id } }) // Only this disposable negative fixture.
    } else if (phase === "write") {
      for (const f of cases.filter((f) => f.name !== mixed)) await persist(f)
    } else if (phase === "interrupt") {
      // Host waits for the AFTER-manifest terminal SQL barrier, then kills only this container.
      await runCheckpoint("interrupt")
    } else if (phase === "resume") {
      assert.equal(
        (await owner.scan.findUniqueOrThrow({ where: { id: checkpoint.id } })).status,
        "VERIFYING"
      )
      const before = []
      for (const f of cases) before.push(await checkCase(f))
      const beforeObjects = await objectIdentity()
      const distinct = before[cases.findIndex((f) => f.name === "distinct-owners")]
      assert.equal(new Set(distinct.historical.map((x) => x.finding)).size, 2)
      assert.deepEqual(distinct.revisions, [
        ["vuln-0001", 1],
        ["vuln-0002", 0],
      ])
      const { reconcileScanQueue, QUEUE_ORPHAN_GRACE_MS } =
        await import("./src/queue-reconciliation.ts")
      const queue = integrations.getScanQueue()
      const enqueue = () =>
        queue.add("scan", jobData(checkpoint.id), { jobId: checkpoint.id, removeOnComplete: true })
      const old = await queue.getJob(checkpoint.id)
      assert.ok(old && (await old.getState()) === "active", "original killed job must still exist")
      // No enqueue/retry here. Stale-scan reconciliation must preserve the already-active job.
      const active = await reconcileScanQueue(new Date(Date.now() + QUEUE_ORPHAN_GRACE_MS + 1000))
      assert.ok(active.leaseAcquired)
      assert.equal(active.failedOrphanedScans, 0)
      assert.equal(
        (await owner.scan.findUniqueOrThrow({ where: { id: checkpoint.id } })).status,
        "VERIFYING"
      )
      await runCheckpoint("recover")
      assert.equal(
        (await owner.scan.findUniqueOrThrow({ where: { id: checkpoint.id } })).status,
        "COMPLETED"
      )
      assert.equal(await owner.scoreSnapshot.count({ where: { scanId: checkpoint.id } }), 1)
      // Freeze the recovery verdict before the separately labelled terminal replay can touch data.
      for (const [i, f] of cases.entries()) assert.deepEqual(await checkCase(f), before[i])
      assert.deepEqual(await objectIdentity(), beforeObjects)
      await runCheckpoint("terminal")
      await enqueue()
      const terminal = await reconcileScanQueue()
      assert.ok(terminal.leaseAcquired)
      assert.equal(terminal.failedOrphanedScans, 0)
      assert.equal(terminal.removedOrphanedJobs, 1)
      assert.ok(!(await queue.getJob(checkpoint.id)))
      assert.equal(
        await owner.scanEvent.count({
          where: { stage: { in: ["engine_start", "engine_exit", "billable_boundary"] } },
        }),
        0
      )
      assert.equal(await owner.scan.count({ where: { status: "COMPLETED" } }), cases.length)
      assert.equal(await owner.scoreSnapshot.count({ where: { scanId: checkpoint.id } }), 1)
      const after = []
      for (const f of cases) after.push(await checkCase(f))
      assert.deepEqual(before, after)
      assert.deepEqual(beforeObjects, await objectIdentity())
      const byName = Object.fromEntries(cases.map((f, i) => [f.name, after[i]]))
      assert.equal(byName[mixed].historical[0].finding, byName[capture].historical[0].finding)
      assert.notEqual(
        byName[mixed].historical[0].observation,
        byName[capture].historical[0].observation
      )
      console.log(
        JSON.stringify({
          service: "private-s3-compatible",
          observations: after,
          objects: Object.keys(beforeObjects).length,
          fixtureManifest: summaryHash,
          source: revision,
          syntheticTerminal: true,
        })
      )
    } else if (phase === "corrupt") {
      const badId = "drill-corrupt-manifest"
      await seedScan(badId)
      const original = await owner.scanResultManifest.findUniqueOrThrow({
        where: { scanId: checkpoint.id },
      })
      await owner.scanResultManifest.create({
        data: {
          scanId: badId,
          manifest: original.manifest,
          version: original.version,
          checksumInput: original.checksumInput,
          checksum: "0".repeat(64),
        },
      })
      const { resumePendingScanFinalization } =
        await import("./src/jobs/run-scan/pending-finalization.ts")
      await assert.rejects(
        () =>
          scoped(() => resumePendingScanFinalization({ scanId: badId, workspaceId: ws, targetId })),
        /failed checksum verification/
      )
      assert.equal(
        (await owner.scan.findUniqueOrThrow({ where: { id: badId } })).status,
        "VERIFYING"
      )
      assert.equal(await owner.scoreSnapshot.count({ where: { scanId: badId } }), 0)
    } else throw new Error("unknown disposable phase")
    assert.ok(!existsSync("/proof/provider-called"), "provider request attempted")
    assert.ok(!existsSync(callsFile), "engine was invoked")
  } finally {
    s3.destroy()
    poison.close()
    await owner.$disconnect()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv[2])
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
