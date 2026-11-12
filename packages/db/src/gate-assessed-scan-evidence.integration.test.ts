import { createHash } from "node:crypto"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RESULT_MANIFEST_VERSION } from "@lyrashield/types"
import { findUnverifiedAssessedScans } from "./gate-assessed-scan-evidence"
import { loadBoundedCandidateManifest } from "./gate-evaluation-service"
import type { ScopedTransaction } from "./rls"

const url = process.env.GATE_SCAN_TEST_DATABASE_URL
const client = new Client({ connectionString: url })
let queries = 0
let lastRows: Record<string, unknown>[] = []
const raw = async (parts: TemplateStringsArray, ...values: unknown[]) => {
  queries++
  const sql = parts.reduce(
    (text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ""),
    ""
  )
  lastRows = (await client.query(sql, values)).rows
  return lastRows
}

describe.skipIf(!url)("bounded assessed scan read against PostgreSQL", () => {
  const coverage = [
    {
      scanner: "sca",
      controlId: "sca",
      status: "COMPLETED",
      reason: null,
      subject: null,
      metadata: null,
    },
  ]
  const manifest = {
    target: { id: "target", type: "REPO" },
    sourceExecution: { sourceRevision: "a".repeat(40) },
    terminalOutcome: { status: "COMPLETED" },
    coverage,
  }
  const bytes = JSON.stringify(manifest)
  const checksum = createHash("sha256").update(bytes).digest("hex")
  const endedAt = new Date("2026-11-12T00:00:00Z")
  const verdict = {
    targetId: "target",
    scanId: "scan",
    assessmentSnapshot: {
      version: 2,
      scanId: "scan",
      completedAtMs: endedAt.getTime(),
      manifestChecksum: checksum,
      manifestVersion: RESULT_MANIFEST_VERSION,
      policyId: "policy",
      policyFingerprint: "fingerprint",
      identity: { kind: "COMMIT", value: "a".repeat(40) },
    },
  }
  const tx = { $queryRaw: raw } as unknown as ScopedTransaction

  beforeAll(async () => {
    await client.connect()
    await client.query(`CREATE TEMP TABLE "Target" ("id" text, "workspaceId" text, "type" text, "deletedAt" timestamp);
      CREATE TEMP TABLE "Scan" ("id" text, "workspaceId" text, "targetId" text, "deletedAt" timestamp, "status" text, "endedAt" timestamp, "policyId" text, "mode" text DEFAULT 'STANDARD');
      CREATE TEMP TABLE "ScanResultManifest" ("scanId" text, "version" integer, "checksum" text, "checksumInput" text, "manifest" jsonb);
      CREATE TEMP TABLE "ScanCoverageReceipt" ("id" text, "scanId" text, "scanner" text, "controlId" text, "status" text, "reason" text, "subject" text, "metadata" jsonb);`)
    await client.query('INSERT INTO "Target" VALUES ($1,$2,$3,NULL)', ["target", "ws", "REPO"])
    await client.query(
      'INSERT INTO "Scan" ("id", "workspaceId", "targetId", "deletedAt", "status", "endedAt", "policyId") VALUES ($1,$2,$3,NULL,$4,$5,$6)',
      ["scan", "ws", "target", "COMPLETED", endedAt, "policy"]
    )
    await client.query('INSERT INTO "ScanResultManifest" VALUES ($1,$2,$3,$4,$5)', [
      "scan",
      RESULT_MANIFEST_VERSION,
      checksum,
      bytes,
      JSON.stringify(manifest),
    ])
    await client.query(
      `INSERT INTO "ScanCoverageReceipt" VALUES ('receipt-1',$1,$2,$3,$4,NULL,NULL,NULL)`,
      ["scan", "sca", "sca", "COMPLETED"]
    )
  })
  afterAll(async () => {
    await client.end()
  })

  it("returns one result per target using a fixed statement count and fails foreign workspace closed", async () => {
    queries = 0
    expect(await findUnverifiedAssessedScans(tx, "ws", [verdict])).toEqual(new Set())
    expect(queries).toBe(1)
    expect(await findUnverifiedAssessedScans(tx, "other", [verdict])).toEqual(new Set(["target"]))
  })

  it("bounds the producer candidate before transfer and scopes it to the workspace and target", async () => {
    expect(await loadBoundedCandidateManifest(tx, "ws", "target", "scan")).toMatchObject({
      checksum,
      manifest,
    })
    expect(await loadBoundedCandidateManifest(tx, "other", "target", "scan")).toBeNull()
    expect(await loadBoundedCandidateManifest(tx, "ws", "other", "scan")).toBeNull()
    await client.query(
      `UPDATE "ScanResultManifest" SET "checksum" = repeat('a', 1024) WHERE "scanId" = 'scan'`
    )
    expect(await loadBoundedCandidateManifest(tx, "ws", "target", "scan")).toBeNull()
    await client.query(`UPDATE "ScanResultManifest" SET "checksum" = $1 WHERE "scanId" = 'scan'`, [
      checksum,
    ])
    await client.query(
      `UPDATE "ScanResultManifest" SET "checksumInput" = repeat('x', 16777217) WHERE "scanId" = 'scan'`
    )
    expect(await loadBoundedCandidateManifest(tx, "ws", "target", "scan")).toBeNull()
    await client.query(
      `UPDATE "ScanResultManifest" SET "checksumInput" = $1,
      "manifest" = jsonb_set("manifest", '{padding}', to_jsonb(repeat('x', 16777217))) WHERE "scanId" = 'scan'`,
      [bytes]
    )
    expect(await loadBoundedCandidateManifest(tx, "ws", "target", "scan")).toBeNull()
    await client.query(
      `UPDATE "ScanResultManifest" SET "manifest" = 'null'::jsonb WHERE "scanId" = 'scan'`
    )
    expect(await loadBoundedCandidateManifest(tx, "ws", "target", "scan")).toBeNull()
    await client.query(
      'UPDATE "ScanResultManifest" SET "manifest" = $1::jsonb WHERE "scanId" = $2',
      [bytes, "scan"]
    )
  })

  it("fails a legacy manifest, altered receipt, and excessive coverage closed", async () => {
    await client.query(
      `UPDATE "ScanResultManifest" SET "checksum" = repeat('x', 1000000) WHERE "scanId" = 'scan'`
    )
    expect(await findUnverifiedAssessedScans(tx, "ws", [verdict])).toEqual(new Set(["target"]))
    expect(lastRows[0]?.resultManifest).toBeNull()
    await client.query(`UPDATE "ScanResultManifest" SET "checksum" = $1 WHERE "scanId" = 'scan'`, [
      checksum,
    ])
    await client.query(
      'UPDATE "ScanResultManifest" SET "checksumInput" = NULL WHERE "scanId" = $1',
      ["scan"]
    )
    expect(await findUnverifiedAssessedScans(tx, "ws", [verdict])).toEqual(new Set(["target"]))
    await client.query('UPDATE "ScanResultManifest" SET "checksumInput" = $1 WHERE "scanId" = $2', [
      bytes,
      "scan",
    ])
    await client.query('UPDATE "ScanCoverageReceipt" SET "status" = $1 WHERE "scanId" = $2', [
      "FAILED",
      "scan",
    ])
    expect(await findUnverifiedAssessedScans(tx, "ws", [verdict])).toEqual(new Set(["target"]))
    await client.query('UPDATE "ScanCoverageReceipt" SET "status" = $1 WHERE "scanId" = $2', [
      "COMPLETED",
      "scan",
    ])
    await client.query(
      `INSERT INTO "ScanCoverageReceipt" SELECT 'extra-' || n, 'scan', 'sca', 'extra-' || n, 'COMPLETED', NULL, NULL, NULL FROM generate_series(1,610) n`
    )
    expect(await findUnverifiedAssessedScans(tx, "ws", [verdict])).toEqual(new Set(["target"]))
  })

  it("accepts the producer's 610 coverage rows and isolates a different target's overflow", async () => {
    const fullCoverage = Array.from({ length: 610 }, (_, n) => ({
      scanner: "sca",
      controlId: `control-${n}`,
      status: "COMPLETED",
      reason: null,
      subject: null,
      metadata: null,
    }))
    const fullManifest = {
      ...manifest,
      target: { id: "other-target", type: "REPO" },
      coverage: fullCoverage,
    }
    const fullBytes = JSON.stringify(fullManifest)
    const fullChecksum = createHash("sha256").update(fullBytes).digest("hex")
    const otherVerdict = {
      targetId: "other-target",
      scanId: "other-scan",
      assessmentSnapshot: {
        ...verdict.assessmentSnapshot,
        scanId: "other-scan",
        manifestChecksum: fullChecksum,
      },
    }
    await client.query('INSERT INTO "Target" VALUES ($1,$2,$3,NULL)', [
      "other-target",
      "ws",
      "REPO",
    ])
    await client.query(
      'INSERT INTO "Scan" ("id", "workspaceId", "targetId", "deletedAt", "status", "endedAt", "policyId") VALUES ($1,$2,$3,NULL,$4,$5,$6)',
      ["other-scan", "ws", "other-target", "COMPLETED", endedAt, "policy"]
    )
    await client.query('INSERT INTO "ScanResultManifest" VALUES ($1,$2,$3,$4,$5)', [
      "other-scan",
      RESULT_MANIFEST_VERSION,
      fullChecksum,
      fullBytes,
      fullBytes,
    ])
    await client.query(
      `INSERT INTO "ScanCoverageReceipt" SELECT 'other-' || n, 'other-scan', 'sca', 'control-' || n, 'COMPLETED', NULL, NULL, NULL FROM generate_series(0,609) n`
    )
    queries = 0
    expect(await findUnverifiedAssessedScans(tx, "ws", [verdict, otherVerdict])).toEqual(
      new Set(["target"])
    )
    expect(queries).toBe(1)
    expect(await findUnverifiedAssessedScans(tx, "ws", [otherVerdict])).toEqual(new Set())
    await client.query(
      `UPDATE "ScanResultManifest" SET "checksumInput" = repeat('x', 16777217) WHERE "scanId" = 'other-scan'`
    )
    expect(await findUnverifiedAssessedScans(tx, "ws", [otherVerdict])).toEqual(
      new Set(["other-target"])
    )
    expect(lastRows[0]?.resultManifest).toBeNull()
  })
})
