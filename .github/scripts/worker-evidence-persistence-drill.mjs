// Mounted alongside the exact worker's src and production dependencies, via its tsx binary.
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
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

function receiptCase(root, name, row, metadata = []) {
  assert.deepEqual(sorted(readdirSync(root)), sorted([...Object.keys(row.files), ...metadata]))
  const bytes = {}
  for (const [filename, expected] of Object.entries(row.files)) {
    assert.ok(["run.json", "vulnerabilities.json", "http_exchanges.json"].includes(filename))
    const raw = readFileSync(join(root, filename))
    assert.equal(raw.length, expected.bytes)
    assert.equal(hash(raw), expected.sha256)
    bytes[filename] = raw.toString("utf8")
  }
  assert.equal(JSON.parse(bytes["run.json"]).run_id, row.run_name)
  assert.equal(JSON.parse(bytes["run.json"]).run_name, row.run_name)
  return { name, id: row.run_name, bytes, row }
}

export function readWriterFixtures(root) {
  const summary = readFileSync(join(root, "summary.json"))
  assert.equal(hash(summary), summaryHash, "unqualified writer fixture manifest")
  const entries = Object.entries(JSON.parse(summary))
  assert.equal(entries.length, 13)
  assert.deepEqual(
    sorted(readdirSync(root)),
    sorted(["summary.json", ...entries.map(([name]) => name)])
  )
  const cases = entries.map(([name, row]) => receiptCase(join(root, name), name, row))
  assert.equal(
    cases.reduce((count, f) => count + Object.keys(f.bytes).length, 0),
    37
  )
  return cases
}

export function distinctFixture(root) {
  const receipt = readFileSync(join(root, "receipt.json"))
  assert.equal(hash(receipt), "737230a09793fb52fd6b1bedacef9ca4f48147a12c5e73bdcb40f872fbe1f4d4")
  return receiptCase(root, "distinct-owners", JSON.parse(receipt), ["receipt.json"])
}

// New, launch-compatible, synthetic legacy controls. They are not writer outputs.
// The original 1.0/1.1 repository goldens intentionally have unequal run_id/run_name.
export function legacy(version) {
  const id = "drill-legacy-" + version
  const run = { run_id: id, run_name: id, status: "completed" }
  if (version === "1.1") run.schema_version = version
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

export function qualifyFixture(
  f,
  { parseEngineOutput, generateDedupeKey, normalizeFindings, filterFalsePositives }
) {
  const output = parseEngineOutput(
    f.bytes["vulnerabilities.json"],
    f.bytes["run.json"],
    { httpExchangesRaw: f.bytes["http_exchanges.json"] },
    { expectedRunName: f.id }
  )
  assert.ok(output.runRecord && output.vulnerabilities.length)
  const raw = output.vulnerabilities.map((v) => ({ ...v, scannerSource: "engine" }))
  if (f.row.status !== "legacy") {
    assert.deepEqual(
      sorted(raw.map((v) => v.id)),
      sorted(Object.keys(f.row.pending)),
      "missing writer owner"
    )
  }
  for (const v of raw) {
    assert.deepEqual(
      v.pending_http_exchange_ids ?? [],
      f.row.pending[v.id] ?? [],
      f.name + ": pending " + v.id
    )
    const ordinary = ["partial", "exported"].includes(f.row.status)
      ? (f.row.ordinary[v.id] ?? [])
      : []
    assert.deepEqual(v.http_exchange_ids ?? [], ordinary, f.name + ": captured " + v.id)
  }
  // All colliding writer owners have equal severity/confidence and identical dedupe fields.
  // Independently choose the first per key; never give it a later owner's IDs.
  const first = new Map()
  for (const v of raw) {
    const key = generateDedupeKey(v, targetId)
    if (!first.has(key)) first.set(key, v)
  }
  const survivors = filterFalsePositives(normalizeFindings(raw, targetId, generateDedupeKey))
  assert.deepEqual(sorted(survivors.map((v) => v.id)), sorted([...first.values()].map((v) => v.id)))
  for (const winner of survivors) {
    const expected = first.get(winner.dedupeKey)
    for (const field of [
      "pending_http_exchange_ids",
      "http_exchange_ids",
      "update_history",
      "evidence_contract_version",
    ]) {
      assert.deepEqual(
        winner[field],
        expected[field],
        f.name + ": changed winning owner's " + field
      )
    }
  }
  const discarded = raw.filter((v) => !survivors.some((s) => s.id === v.id))
  return { output, survivors, discarded }
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
    const { output, survivors, discarded } = parse(f)
    const stored = await owner.scanResultManifest.findUniqueOrThrow({ where: { scanId: f.id } })
    assert.equal(db.verifyStoredManifestChecksum(stored), "MATCH")
    const evidence = stored.manifest.httpExchangeEvidence
    const rowReceipt = await owner.findingVerification.findMany({
      where: { scanId: f.id },
      orderBy: { id: "asc" },
    })
    assert.equal(rowReceipt.length, survivors.length)
    assert.equal(await owner.findingCandidate.count({ where: { scanId: f.id } }), survivors.length)
    const exportDoc = output.httpExchangeExport?.document
    if (exportDoc) {
      assert.equal(evidence.checksum, hash(exportDoc))
      assert.equal(evidence.byteLength, Buffer.byteLength(exportDoc))
      assert.equal(evidence.exchangeCount, output.httpExchangeExport.exchangeCount)
      const uri =
        "s3://" +
        bucket +
        "/evidence/" +
        ws +
        "/" +
        f.id +
        "/http_exchanges/http-exchanges-" +
        evidence.checksum
      const read = await readEncryptedArtifact(uri, ws)
      assert.equal(read.content.toString(), exportDoc)
      assert.equal(read.checksum, evidence.checksum)
      assert.equal(read.legacy, false)
      const retained = JSON.parse(read.content.toString())
      const rawExport = JSON.parse(f.bytes["http_exchanges.json"])
      const expectedIds = [...new Set(Object.values(f.row.ordinary).flat())]
      assert.deepEqual(
        sorted(retained.exchanges.map((e) => e.proxy_request_id)),
        sorted(expectedIds)
      )
      assert.equal(
        retained.binding.report_artifacts_revision,
        rawExport.binding.report_artifacts_revision
      )
      assert.equal(retained.binding.run_id, f.id)
      assert.equal(retained.binding.run_name, f.id)
      assert.deepEqual(retained.binding.finding_revisions, rawExport.binding.finding_revisions)
    } else assert.equal(evidence, undefined)
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
      assert.equal(content.evidenceContractVersion, winner.evidence_contract_version)
      assert.equal(content.sourceScanId, f.id)
      assert.equal(content.sourceFindingId, finding.id)
      assert.deepEqual(content.updateHistory, winner.update_history)
      const pending = f.row.pending[winner.id] ?? [],
        captured = winner.http_exchange_ids ?? []
      assert.deepEqual(content.pendingHttpExchangeIds ?? [], pending)
      assert.equal(content.pendingHttpExchangeState, pending.length ? "PENDING" : undefined)
      assert.deepEqual(content.httpExchangeIds ?? [], captured)
      const captureHash = captured.length ? evidence.checksum : undefined
      assert.equal(content.httpExchangeArtifactChecksum, captureHash)
      const candidate = await owner.findingCandidate.findFirstOrThrow({
        where: {
          scanId: f.id,
          dedupeKey: winner.dedupeKey,
          scannerSource: "engine",
        },
      })
      assert.equal(candidate.payload.id, winner.id)
      assert.deepEqual(candidate.payload.httpExchangeIds, captured)
      assert.ok(!Object.keys(candidate.payload).some((k) => /pending/i.test(k)))
      const vr = rowReceipt.find((v) => v.findingId === finding.id)
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
      revisions: survivors.map((v) => [v.id, v.update_history?.length ?? 0]),
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

  async function replay(f) {
    const { Worker } = await import("bullmq")
    const { SCAN_QUEUE_NAME } = await import("@lyrashield/types")
    const { processScanJob } = await import("./src/jobs/run-scan.job.ts")
    const q = integrations.getScanQueue()
    const worker = new Worker(SCAN_QUEUE_NAME, undefined, {
      connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
      autorun: false,
    })
    try {
      await worker.waitUntilReady()
      await q.add("scan", jobData(f.id), { jobId: f.id, removeOnComplete: true })
      const token = randomUUID()
      const job = await worker.getNextJob(token)
      assert.equal(job?.id, f.id)
      const result = await processScanJob(job)
      assert.equal(result.status, "completed")
      await job.moveToCompleted(result, token, false)
    } finally {
      await worker.close()
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
      await persist(checkpoint)
      throw new Error("terminal barrier was bypassed")
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
      await enqueue()
      // Deliberately age only the sweep's clock: a real processable BullMQ job protects the checkpoint.
      const active = await reconcileScanQueue(new Date(Date.now() + QUEUE_ORPHAN_GRACE_MS + 1000))
      assert.ok(active.leaseAcquired)
      assert.equal(active.queueDepth, 1)
      assert.equal(active.failedOrphanedScans, 0)
      await replay(checkpoint)
      await replay(checkpoint)
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
