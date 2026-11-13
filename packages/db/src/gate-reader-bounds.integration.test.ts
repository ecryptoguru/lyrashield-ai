import { createHash } from "node:crypto"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { findMismatchedGateEvidence } from "./gate-reader-evidence"
import { readActiveSharedReport } from "./report-service"
import { loadBoundedGateVerdicts, MAX_GATE_VERDICT_BYTES } from "./gate-verdict-read"
import {
  MAX_RETEST_COVERAGE_RECEIPTS,
  loadReceiptBackedRetestFindingIdsAcrossTargets,
} from "./retest-evidence-trust"
import type { ScopedTransaction } from "./rls"

const url = process.env.GATE_READER_TEST_DATABASE_URL
const client = new Client({ connectionString: url })
const zero = {
  detected: 0,
  validated: 0,
  verified: 0,
  retestConfirmed: 0,
  inconclusive: 0,
  blockingUnverified: 0,
}
let queryCount = 0
let findingRows: Record<string, unknown>[] = []
let candidateGroups: Record<string, unknown>[] = []
const raw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  queryCount++
  const sql = strings.reduce(
    (text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ""),
    ""
  )
  const rows = (await client.query(sql, values)).rows
  if (sql.includes('"targetEvidenceTooLarge"')) findingRows = rows
  if (sql.includes("candidate_cap")) candidateGroups = rows
  return rows
}

describe.skipIf(!url)("per-target gate bounds against PostgreSQL", () => {
  beforeAll(async () => {
    await client.connect()
    await client.query(`CREATE TEMP TABLE "Finding" (
      "id" text, "workspaceId" text, "targetId" text, "severity" text, "status" text,
      "verificationStatus" text, "lastSeenAt" timestamp, "scanId" text, "dedupeKey" text,
      "disposition" text, "dispositionActorUserId" text, "dispositionReason" text,
      "dispositionAssessmentId" text, "dispositionAt" timestamp, "canonicalFindingId" text, "deletedAt" timestamp
    ); CREATE TEMP TABLE "FindingVerification" (
      "id" text, "workspaceId" text, "findingId" text, "status" text, "method" text, "scanId" text,
      "verifierVersion" text, "evidence" jsonb, "createdAt" timestamp
    ); CREATE TEMP TABLE "Scan" (
      "id" text, "workspaceId" text, "targetId" text, "status" text, "deletedAt" timestamp
    ); CREATE TEMP TABLE "ScanResultManifest" (
      "scanId" text, "checksum" text, "checksumInput" text, "manifest" jsonb
    ); CREATE TEMP TABLE "ScanCoverageReceipt" (
      "id" text, "scanId" text, "scanner" text, "controlId" text, "status" text,
      "reason" text, "subject" text, "metadata" jsonb
    ); CREATE TEMP TABLE "Retest" (
      "id" text, "workspaceId" text, "findingId" text, "scanId" text, "status" text
    ); CREATE TEMP TABLE "Report" (
      "id" text, "workspaceId" text, "shareTokenHash" text, "revokedAt" timestamp,
      "deletedAt" timestamp, "shareExpiresAt" timestamp
    ); CREATE TEMP TABLE "FindingCandidate" (
      "id" text, "workspaceId" text, "targetId" text, "findingId" text, "scanId" text,
      "dedupeKey" text, "scannerSource" text, "payload" jsonb
    ); CREATE TEMP TABLE "Target" (
      "id" text, "workspaceId" text, "deletedAt" timestamp
    ); CREATE TEMP TABLE "GateVerdict" (
      "id" text, "workspaceId" text, "targetId" text, "scanId" text, "standardVersion" text,
      "state" text, "coverageStatement" jsonb, "nonCoverage" jsonb, "blockingReasons" jsonb,
      "evidenceSummary" jsonb, "staleness" jsonb, "inputChecksum" text, "verdictChecksum" text,
      "assessmentVersion" int, "assessmentSnapshot" jsonb, "evaluatedAt" timestamp
    );`)
  })

  it("bounds latest verdicts before transport and isolates oversized targets", async () => {
    await client.query(
      `INSERT INTO "Target" VALUES ('verdict-large', 'ws', NULL), ('verdict-small', 'ws', NULL)`
    )
    await client.query(
      `INSERT INTO "GateVerdict" VALUES
      ('old-large', 'ws', 'verdict-large', 'scan', 'v', 'READY', '[]', '[]', '[]', '{}', '{}', 'i', 'v', 1, '{}', '2026-01-01'),
      ('new-large', 'ws', 'verdict-large', 'scan', 'v', 'READY', jsonb_build_array(repeat('x', $1)), '[]', '[]', '{}', '{}', 'i', 'v', 1, '{}', '2026-01-02'),
      ('small-verdict', 'ws', 'verdict-small', 'scan', 'v', 'READY', '[]', '[]', '[]', '{}', '{}', 'i', 'v', 1, '{}', '2026-01-02')`,
      [MAX_GATE_VERDICT_BYTES + 1]
    )
    const tx = { $queryRaw: raw } as unknown as ScopedTransaction
    const both = await loadBoundedGateVerdicts(tx, "ws", {
      targetIds: ["verdict-large", "verdict-small"],
    })
    expect(both).toHaveLength(2)
    expect(both[0]).toMatchObject({
      id: "new-large",
      evidenceTooLarge: true,
      coverageStatement: null,
      state: "READY",
    })
    expect(both[1]).toMatchObject({ id: "small-verdict", evidenceTooLarge: false, state: "READY" })
    expect(await loadBoundedGateVerdicts(tx, "ws", { targetIds: ["verdict-large"] })).toEqual([
      both[0],
    ])
    expect(await loadBoundedGateVerdicts(tx, "ws", { verdictId: "new-large" })).toEqual([both[0]])
    expect(await loadBoundedGateVerdicts(tx, "another-ws", { verdictId: "small-verdict" })).toEqual(
      []
    )
    await client.query(`UPDATE "Target" SET "deletedAt" = NOW() WHERE "id" = 'verdict-small'`)
    expect(
      await loadBoundedGateVerdicts(tx, "ws", {
        verdictId: "small-verdict",
        requireActiveTarget: true,
      })
    ).toEqual([])
  })
  afterAll(async () => {
    await client.end()
  })

  it("isolates more than 10,000 findings to their target and preserves batch/single parity", async () => {
    await client.query(
      `INSERT INTO "Finding" ("id", "workspaceId", "targetId", "severity", "status", "verificationStatus", "lastSeenAt", "scanId", "dedupeKey") SELECT 'f-' || n, 'ws', 'large', 'LOW', 'OPEN', 'DETECTED', NOW(), 'scan', 'k-' || n FROM generate_series(1,10001) AS n`
    )
    const tx = { $queryRaw: raw } as unknown as ScopedTransaction
    const verdicts = ["large", "small"].map((targetId) => ({
      targetId,
      scanId: "scan",
      evidenceSummary: zero,
      blockingReasons: [],
    }))
    queryCount = 0
    expect(await findMismatchedGateEvidence(tx, "ws", verdicts)).toEqual(new Set(["large"]))
    expect(queryCount).toBe(1)
    expect(await findMismatchedGateEvidence(tx, "ws", [verdicts[0]!])).toEqual(new Set(["large"]))
    expect(await findMismatchedGateEvidence(tx, "ws", [verdicts[1]!])).toEqual(new Set())
  })

  it("does not transport a target's excessive aggregate receipt bytes", async () => {
    await client.query(
      `INSERT INTO "Finding" ("id", "workspaceId", "targetId", "severity", "status", "verificationStatus", "lastSeenAt", "scanId", "dedupeKey") SELECT 'byte-f-' || n, 'ws', 'byte-target', 'LOW', 'OPEN', 'DETECTED', NOW(), 'scan', 'k-' || n FROM generate_series(1,5) AS n`
    )
    await client.query(
      `INSERT INTO "FindingVerification" SELECT 'byte-v-' || n, 'ws', 'byte-f-' || n, 'VALIDATED', 'RETEST', 'scan', 'v1', jsonb_build_object('blob', repeat('x', 900000)), NOW() FROM generate_series(1,5) AS n`
    )
    const tx = { $queryRaw: raw } as unknown as ScopedTransaction
    const verdicts = ["byte-target", "empty-target"].map((targetId) => ({
      targetId,
      scanId: "scan",
      evidenceSummary: zero,
      blockingReasons: [],
    }))
    expect(await findMismatchedGateEvidence(tx, "ws", verdicts)).toEqual(new Set(["byte-target"]))
    expect(
      findingRows.every(
        (row) =>
          row.targetEvidenceTooLarge === true &&
          Array.isArray(row.verificationReceipts) &&
          row.verificationReceipts.length === 0
      )
    ).toBe(true)
  })

  it("does not transport arbitrary verifier version text", async () => {
    await client.query(
      `INSERT INTO "Finding" ("id", "workspaceId", "targetId", "severity", "status", "verificationStatus", "lastSeenAt", "scanId", "dedupeKey") VALUES ('version-f', 'ws', 'version-target', 'LOW', 'OPEN', 'DETECTED', NOW(), 'scan', 'key')`
    )
    await client.query(
      `INSERT INTO "FindingVerification" VALUES ('version-v', 'ws', 'version-f', 'VALIDATED', 'RETEST', 'scan', repeat('x', 2000000), '{}'::jsonb, NOW())`
    )
    const tx = { $queryRaw: raw } as unknown as ScopedTransaction
    await findMismatchedGateEvidence(tx, "ws", [
      { targetId: "version-target", scanId: "scan", evidenceSummary: zero, blockingReasons: [] },
    ])
    expect(findingRows[0]?.verificationReceipts).toEqual([
      expect.objectContaining({ verifierVersion: null }),
    ])
  })

  it("isolates candidate and scan coverage limits without rejecting a valid other target", async () => {
    function fixture(targetId: string) {
      const makeScan = (id: string, rev: string) => {
        const manifest = {
          target: { id: targetId, type: "REPO", urlChecksum: null },
          sourceExecution: { sourceRevision: rev },
          terminalOutcome: { status: "COMPLETED" },
          coverage: [{ scanner: "sca", controlId: "sca", status: "COMPLETED" }],
        }
        const checksumInput = JSON.stringify(manifest)
        const checksum = createHash("sha256").update(checksumInput).digest("hex")
        return {
          id,
          workspaceId: "ws",
          targetId,
          status: "COMPLETED",
          resultManifest: { checksum, checksumInput, manifest },
          coverageReceipts: [
            {
              id: `coverage-${id}`,
              scanId: id,
              scanner: "sca",
              controlId: "sca",
              status: "COMPLETED",
              reason: null,
              subject: null,
              metadata: null,
            },
          ],
        }
      }
      const baseline = makeScan(`${targetId}-base`, "b".repeat(40))
      const retestScan = makeScan(`${targetId}-retest`, "c".repeat(40))
      const identity = (scan: typeof baseline) => ({
        scanId: scan.id,
        manifestChecksum: scan.resultManifest.checksum,
        sourceRevision: scan.resultManifest.manifest.sourceExecution.sourceRevision,
        targetUrlChecksum: null,
      })
      const finding = {
        id: `${targetId}-finding`,
        targetId,
        scanId: baseline.id,
        dedupeKey: `${targetId}-key`,
        verificationReceipts: [
          {
            status: "VALIDATED",
            method: "RETEST",
            scanId: retestScan.id,
            verifierVersion: "result-integrity-v3",
            evidence: {
              retestId: `${targetId}-receipt`,
              scannerSource: "sca",
              baseline: identity(baseline),
              retest: identity(retestScan),
              coverageReceiptIds: [`coverage-${baseline.id}`, `coverage-${retestScan.id}`],
            },
          },
        ],
      }
      return {
        baseline,
        retestScan,
        finding,
        retest: {
          id: `${targetId}-receipt`,
          workspaceId: "ws",
          findingId: finding.id,
          scanId: retestScan.id,
          status: "passed",
        },
      }
    }
    const a = fixture("large")
    const b = fixture("small")
    await client.query(
      `INSERT INTO "FindingCandidate" SELECT 'candidate-' || n, 'ws', 'large', NULL, 'large-retest', 'other-' || n, 'sca', '{}'::jsonb FROM generate_series(1,20001) AS n`
    )
    await client.query(
      `INSERT INTO "FindingCandidate" VALUES ('small-candidate', 'ws', 'small', 'small-finding', 'small-base', 'small-key', 'sca', '{}'::jsonb)`
    )
    const scans = [a.baseline, a.retestScan, b.baseline, b.retestScan]
    for (const scan of scans) {
      await client.query('INSERT INTO "Scan" VALUES ($1,$2,$3,$4,NULL)', [
        scan.id,
        scan.workspaceId,
        scan.targetId,
        scan.status,
      ])
      await client.query('INSERT INTO "ScanResultManifest" VALUES ($1,$2,$3,$4)', [
        scan.id,
        scan.resultManifest.checksum,
        scan.resultManifest.checksumInput,
        JSON.stringify(scan.resultManifest.manifest),
      ])
      const coverage = scan.coverageReceipts[0]!
      await client.query('INSERT INTO "ScanCoverageReceipt" VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        coverage.id,
        coverage.scanId,
        coverage.scanner,
        coverage.controlId,
        coverage.status,
        coverage.reason,
        coverage.subject,
        coverage.metadata,
      ])
    }
    for (const retest of [a.retest, b.retest])
      await client.query('INSERT INTO "Retest" VALUES ($1,$2,$3,$4,$5)', [
        retest.id,
        retest.workspaceId,
        retest.findingId,
        retest.scanId,
        retest.status,
      ])
    const tx = { $queryRaw: raw } as unknown as ScopedTransaction
    async function evaluate(findings: (typeof a.finding)[]) {
      const unverified = new Set<string>()
      const trusted = await loadReceiptBackedRetestFindingIdsAcrossTargets(tx, {
        workspaceId: "ws",
        findings,
        bounded: true,
        unverifiedTargetIds: unverified,
      })
      return { trusted, unverified }
    }
    await client.query(
      `INSERT INTO "Finding" ("id", "workspaceId", "targetId", "severity", "status", "verificationStatus", "lastSeenAt", "scanId", "dedupeKey") VALUES ('small-finding', 'ws', 'small', 'HIGH', 'FIXED', 'DETECTED', NOW(), 'small-base', 'small-key')`
    )
    await client.query(
      `INSERT INTO "FindingVerification" VALUES ('old-valid','ws','small-finding','VALIDATED','RETEST','small-retest','result-integrity-v3',$1,'2026-01-01')`,
      [JSON.stringify(b.finding.verificationReceipts[0]!.evidence)]
    )
    await client.query(
      `INSERT INTO "FindingVerification" VALUES ('new-invalid','ws','small-finding','VALIDATED','RETEST','small-retest','result-integrity-v3','{}','2026-01-02')`
    )
    const receiptSummary = {
      detected: 1,
      validated: 0,
      verified: 0,
      retestConfirmed: 1,
      inconclusive: 0,
      insufficientPositiveEvidence: 0,
      blockingUnverified: 0,
      unresolvedCritical: 0,
      unresolvedHigh: 0,
      unresolvedMedium: 0,
      unresolvedLow: 0,
      acceptedRisk: 0,
      falsePositive: 0,
    }
    const verdict = [
      {
        targetId: "small",
        scanId: "small-retest",
        evidenceSummary: receiptSummary,
        blockingReasons: [],
      },
    ]
    expect(await findMismatchedGateEvidence(tx, "ws", verdict)).toEqual(new Set(["small"]))
    await client.query(`DELETE FROM "FindingVerification" WHERE "id" = 'new-invalid'`)
    await client.query(
      `INSERT INTO "FindingVerification" SELECT 'extra-' || n, 'ws', 'small-finding', 'VERIFIED', 'MANUAL', 'small-retest', 'v1', NULL, '2025-01-01'::timestamp FROM generate_series(1,101) AS n`
    )
    expect(await findMismatchedGateEvidence(tx, "ws", verdict)).toEqual(new Set())
    await client.query(
      `INSERT INTO "ScanCoverageReceipt" SELECT 'small-extra-' || n, 'small-base', 'unused', 'extra-' || n, 'COMPLETED', NULL, NULL, NULL FROM generate_series(1,${MAX_RETEST_COVERAGE_RECEIPTS - 1}) AS n`
    )
    const both = await evaluate([a.finding, b.finding])
    expect(both).toEqual({ trusted: new Set([b.finding.id]), unverified: new Set(["large"]) })
    expect(await evaluate([a.finding])).toEqual({
      trusted: new Set(),
      unverified: new Set(["large"]),
    })
    expect(await evaluate([b.finding])).toEqual({
      trusted: new Set([b.finding.id]),
      unverified: new Set(),
    })
    await client.query(`DELETE FROM "FindingCandidate" WHERE "targetId" = 'large'`)
    await client.query(
      `INSERT INTO "FindingCandidate" SELECT 'blob-candidate-' || n, 'ws', 'large', NULL, 'large-retest', 'blob-' || n, 'sca', jsonb_build_object('blob', repeat('x', 900000)) FROM generate_series(1,5) AS n`
    )
    expect(await evaluate([a.finding, b.finding])).toEqual({
      trusted: new Set([b.finding.id]),
      unverified: new Set(["large"]),
    })
    expect(candidateGroups.find((group) => group.targetId === "large")).toMatchObject({
      overflow: true,
      items: [],
    })
    await client.query(
      `UPDATE "ScanResultManifest" SET "checksum" = repeat('x', 1000000) WHERE "scanId" = 'large-base'`
    )
    expect(await evaluate([a.finding, b.finding])).toEqual({
      trusted: new Set([b.finding.id]),
      unverified: new Set(["large"]),
    })
    expect(candidateGroups.find((group) => group.targetId === "large")).toBeUndefined()
    await client.query(
      `UPDATE "ScanResultManifest" SET "checksum" = $1 WHERE "scanId" = 'large-base'`,
      [a.baseline.resultManifest.checksum]
    )
    await client.query(
      `UPDATE "ScanResultManifest" SET "checksumInput" = repeat('x', 17000000) WHERE "scanId" = 'large-base'`
    )
    expect(await evaluate([a.finding, b.finding])).toEqual({
      trusted: new Set([b.finding.id]),
      unverified: new Set(["large"]),
    })
    await client.query('UPDATE "ScanResultManifest" SET "checksumInput" = $1 WHERE "scanId" = $2', [
      a.baseline.resultManifest.checksumInput,
      "large-base",
    ])

    await client.query(
      `INSERT INTO "ScanCoverageReceipt" SELECT 'extra-' || n, 'large-base', 'sca', 'extra-' || n, 'COMPLETED', NULL, NULL, NULL FROM generate_series(1,${MAX_RETEST_COVERAGE_RECEIPTS}) AS n`
    )
    const coverage = await evaluate([a.finding, b.finding])
    expect(coverage).toEqual({ trusted: new Set([b.finding.id]), unverified: new Set(["large"]) })
  })
  it("revalidates the share capability at the content read", async () => {
    const token = "a".repeat(64)
    const hash = createHash("sha256").update(token).digest("hex")
    await client.query(
      `INSERT INTO "Report" VALUES ($1, $2, $3, NULL, NULL, now() + interval '1 hour')`,
      ["report", "ws", hash]
    )
    const tx = { $queryRaw: raw } as unknown as ScopedTransaction
    expect((await readActiveSharedReport(tx, "ws", "report", token))?.id).toBe("report")
    expect(await readActiveSharedReport(tx, "other", "report", token)).toBeNull()
    await client.query('UPDATE "Report" SET "revokedAt" = now() WHERE "id" = $1', ["report"])
    expect(await readActiveSharedReport(tx, "ws", "report", token)).toBeNull()
    await client.query(
      'UPDATE "Report" SET "revokedAt" = NULL, "shareTokenHash" = $1 WHERE "id" = $2',
      ["rotated", "report"]
    )
    expect(await readActiveSharedReport(tx, "ws", "report", token)).toBeNull()
  })
})
