import { createHash, randomUUID } from "node:crypto"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { findMismatchedGateEvidence } from "./gate-reader-evidence"
import { loadVerifiedAssessedScans } from "./gate-assessed-scan-evidence"
import { loadBoundedGateVerdicts, MAX_GATE_VERDICT_BYTES } from "./gate-verdict-read"
import {
  computeGateVerdict,
  computeInputChecksum,
  computeVerdictChecksum,
  requiredScannersForTarget,
  type GateEvidenceInput,
} from "@lyrashield/gate"
import { RESULT_MANIFEST_VERSION } from "@lyrashield/types"
import type { ScopedTransaction } from "./rls"

// Hoisting runs this guard before imports can construct the runtime client.
// The fixture pairs the GATE_READER_OWNER_DATABASE_URL role with the restricted
// GATE_READER_RUNTIME_DATABASE_URL role; bind that pair through the shared
// disposable-pair guard.
await vi.hoisted(async () => {
  const owner = process.env.GATE_READER_OWNER_DATABASE_URL
  const runtime = process.env.GATE_READER_RUNTIME_DATABASE_URL
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || !owner || !runtime) return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({
    ...process.env,
    DATABASE_URL: owner,
    RLS_RUNTIME_DATABASE_URL: runtime,
  })
})

const ownerUrl = process.env.GATE_READER_OWNER_DATABASE_URL
const runtimeUrl = process.env.GATE_READER_RUNTIME_DATABASE_URL
const enabled = Boolean(ownerUrl && runtimeUrl && process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1")
const suffix = randomUUID()
const workspaces = [`gate-a-${suffix}`, `gate-b-${suffix}`]
const targets = [`target-a-${suffix}`, `target-b-${suffix}`]
const owner = new Client({ connectionString: ownerUrl })
const runtime = new Client({ connectionString: runtimeUrl })
const summary = {
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
const zero = Object.fromEntries(Object.keys(summary).map((key) => [key, 0]))
const assessedAt = new Date(Date.now() - 60_000)
const lastSeen = new Date(assessedAt.getTime() - 1000)
let currentVerdict:
  | (ReturnType<typeof computeGateVerdict> & {
      targetId: string
      scanId: string
      inputChecksum: string
      verdictChecksum: string
      assessmentSnapshot: unknown
    })
  | undefined
let rowsSeen: string[] = []
let calls = 0
const raw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  calls++
  const sql = strings.reduce(
    (text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ""),
    ""
  )
  const rows = (await runtime.query(sql, values)).rows
  if (sql.includes('"verificationReceipts"') && sql.includes('"Finding"'))
    rowsSeen = rows.map((row) => row.targetId)
  return rows
}

describe.skipIf(!enabled)("gate evidence reader under real PostgreSQL RLS", () => {
  beforeAll(async () => {
    const admin = new URL(ownerUrl!)
    const restricted = new URL(runtimeUrl!)
    const configured = new URL(process.env.DATABASE_URL ?? "")
    const disposableName = decodeURIComponent(admin.pathname.slice(1))
    if (
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(admin.hostname) ||
      admin.hostname !== restricted.hostname ||
      admin.port !== restricted.port ||
      admin.pathname !== restricted.pathname ||
      admin.hostname !== configured.hostname ||
      admin.port !== configured.port ||
      admin.pathname !== configured.pathname ||
      !/(?:^|[_-])(?:test|ci|disposable)(?:$|[_-])/i.test(disposableName)
    )
      throw new Error("Requires one local disposable database for both roles")
    await owner.connect()
    await runtime.connect()
    const role = (
      await runtime.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
      )
    ).rows[0]
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    for (let i = 0; i < 2; i++) {
      const ws = workspaces[i]!,
        target = targets[i]!,
        baseline = `base-${i}-${suffix}`,
        retest = `retest-${i}-${suffix}`,
        finding = `finding-${i}-${suffix}`
      await owner.query(
        'INSERT INTO "Workspace" (id, name, slug, "updatedAt") VALUES ($1,$1,$1,NOW())',
        [ws]
      )
      await owner.query(
        'INSERT INTO "Target" (id,"workspaceId",type,name,"updatedAt") VALUES ($1,$2,\'REPO\',$1,NOW())',
        [target, ws]
      )
      const policyId = `policy-${i}-${suffix}`
      await owner.query(
        'INSERT INTO "Policy" (id,"workspaceId",name,"updatedAt") VALUES ($1,$2,$1,NOW())',
        [policyId, ws]
      )
      for (const scan of [baseline, retest])
        await owner.query(
          'INSERT INTO "Scan" (id,"workspaceId","targetId","policyId",goal,status,"createdById","endedAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())',
          [scan, ws, target, policyId, "TEST_APP", "COMPLETED", "fixture", assessedAt]
        )
      await owner.query(
        'INSERT INTO "Finding" (id,"workspaceId","targetId","scanId",title,summary,severity,status,"verificationStatus","dedupeKey","lastSeenAt","updatedAt") VALUES ($1,$2,$3,$4,\'fixture\',\'fixture\',\'HIGH\',\'FIXED\',\'DETECTED\',$1,$5,NOW())',
        [finding, ws, target, baseline, lastSeen]
      )
      const evidenceIdentity = new Map<
        string,
        {
          scanId: string
          manifestChecksum: string
          sourceRevision: string
          targetUrlChecksum: null
        }
      >()
      if (i === 0) {
        for (const [scanId, revision] of [
          [baseline, "b".repeat(40)],
          [retest, "c".repeat(40)],
        ]) {
          const manifest = {
            target: { id: target, type: "REPO", urlChecksum: null },
            sourceExecution: { sourceRevision: revision },
            terminalOutcome: { status: "COMPLETED" },
            coverage: requiredScannersForTarget("REPO", "SAFE").map((scanner) => ({
              scanner,
              controlId: scanner,
              status: "COMPLETED",
            })),
          }
          const checksumInput = JSON.stringify(manifest)
          const checksum = createHash("sha256").update(checksumInput).digest("hex")
          await owner.query(
            'INSERT INTO "ScanResultManifest" (id,"scanId",version,manifest,checksum,"checksumInput") VALUES ($1,$2,$3,$4,$5,$6)',
            [
              `manifest-${scanId}`,
              scanId,
              RESULT_MANIFEST_VERSION,
              checksumInput,
              checksum,
              checksumInput,
            ]
          )
          for (const scanner of requiredScannersForTarget("REPO", "SAFE")) {
            await owner.query(
              'INSERT INTO "ScanCoverageReceipt" (id,"scanId",scanner,"controlId",status) VALUES ($1,$2,$3,$4,$5)',
              [`coverage-${scanId}-${scanner}`, scanId, scanner, scanner, "COMPLETED"]
            )
          }
          if (scanId === retest) {
            const gateInput: GateEvidenceInput = {
              targetId: target,
              latestCompletedScan: {
                id: retest,
                endedAtMs: assessedAt.getTime(),
                status: "COMPLETED",
                mode: "SAFE",
              },
              coverageReceipts: requiredScannersForTarget("REPO", "SAFE").map((scanner) => ({
                scanner,
                controlId: scanner,
                status: "COMPLETED",
                reason: null,
              })),
              findings: [
                {
                  id: finding,
                  severity: "HIGH",
                  status: "FIXED",
                  verificationStatus: "DETECTED",
                  retestConfirmedResolved: true,
                  hasPositiveEvidence: true,
                  hasApplicableDisposition: false,
                  applicableDisposition: null,
                  duplicateCanonicalResolved: true,
                  lastSeenAtMs: lastSeen.getTime(),
                },
              ],
              requiredScanners: requiredScannersForTarget("REPO", "SAFE"),
              targetTypeCovered: true,
              policyFingerprint: "fixture-policy",
              assessmentIdentityComplete: true,
            }
            const evaluated = computeGateVerdict(gateInput)
            currentVerdict = {
              targetId: target,
              scanId: retest,
              ...evaluated,
              inputChecksum: computeInputChecksum(gateInput),
              verdictChecksum: computeVerdictChecksum(evaluated),
              assessmentSnapshot: {
                version: 2,
                scanId: retest,
                completedAtMs: assessedAt.getTime(),
                manifestChecksum: checksum,
                manifestVersion: RESULT_MANIFEST_VERSION,
                policyId,
                policyFingerprint: "fixture-policy",
                identity: { kind: "COMMIT", value: revision },
              },
            }
          }
          evidenceIdentity.set(scanId, {
            scanId,
            manifestChecksum: checksum,
            sourceRevision: revision,
            targetUrlChecksum: null,
          })
        }
        await owner.query(
          'INSERT INTO "Retest" (id,"workspaceId","findingId","scanId",status,"updatedAt") VALUES ($1,$2,$3,$4,$5,NOW())',
          [`receipt-${i}-${suffix}`, ws, finding, retest, "passed"]
        )
        await owner.query(
          'INSERT INTO "FindingCandidate" (id,"workspaceId","targetId","scanId","findingId","scannerSource","dedupeKey",payload,"evidenceHash","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$5,$7,$8,NOW())',
          [`candidate-${i}-${suffix}`, ws, target, baseline, finding, "sca", "{}", "fixture"]
        )
      }
      const identity = (scanId: string) =>
        evidenceIdentity.get(scanId) ?? {
          scanId,
          manifestChecksum: "a".repeat(64),
          sourceRevision: "b".repeat(40),
          targetUrlChecksum: null,
        }
      const evidence = {
        retestId: `receipt-${i}-${suffix}`,
        scannerSource: "sca",
        baseline: identity(baseline),
        retest: identity(retest),
        coverageReceiptIds:
          i === 0
            ? [`coverage-${baseline}-sca`, `coverage-${retest}-sca`]
            : ["receipt-a", "receipt-b"],
      }
      await owner.query(
        'INSERT INTO "FindingVerification" (id,"workspaceId","findingId","scanId",status,method,reason,"verifierVersion",evidence,"idempotencyKey") VALUES ($1,$2,$3,$4,\'VALIDATED\',\'RETEST\',\'fixture\',\'result-integrity-v3\',$5,$1)',
        [`verification-${i}-${suffix}`, ws, finding, retest, JSON.stringify(evidence)]
      )
      await owner.query(
        `INSERT INTO "GateVerdict" (id,"workspaceId","targetId","scanId","standardVersion",state,"coverageStatement","nonCoverage","blockingReasons","evidenceSummary",staleness,"inputChecksum","verdictChecksum","assessmentVersion","assessmentSnapshot","evaluatedAt")
         VALUES ($1,$2,$3,$4,'v','READY',jsonb_build_array(repeat('x',$5)),'[]','[]','{}','{}','i','v',2,'{}',NOW())`,
        [`verdict-${i}-${suffix}`, ws, target, retest, i === 0 ? MAX_GATE_VERDICT_BYTES + 1 : 1]
      )
    }
  })

  it("bounds verdict transport and enforces workspace RLS", async () => {
    await runtime.query("BEGIN ISOLATION LEVEL REPEATABLE READ")
    try {
      const tx = { $queryRaw: raw } as unknown as ScopedTransaction
      await runtime.query("SELECT set_config('app.current_workspace_id',$1,true)", [workspaces[0]])
      const rows = await loadBoundedGateVerdicts(tx, workspaces[0]!, { targetIds: targets })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        targetId: targets[0],
        evidenceTooLarge: true,
        coverageStatement: null,
      })
      expect(
        await loadBoundedGateVerdicts(tx, workspaces[1]!, { verdictId: `verdict-1-${suffix}` })
      ).toEqual([])
    } finally {
      await runtime.query("ROLLBACK")
    }
  })
  afterAll(async () => {
    try {
      if (ownerUrl)
        await owner.query('DELETE FROM "Workspace" WHERE id = ANY($1::text[])', [workspaces])
    } finally {
      await Promise.all([owner.end(), runtime.end()])
    }
  })

  it("recomputes a checksum-bound READY from the real scoped manifest and coverage", async () => {
    if (!currentVerdict) throw new Error("Missing gate fixture")
    await runtime.query("BEGIN ISOLATION LEVEL REPEATABLE READ")
    try {
      const tx = { $queryRaw: raw } as unknown as ScopedTransaction
      await runtime.query("SELECT set_config('app.current_workspace_id',$1,true)", [workspaces[0]])
      const assessed = await loadVerifiedAssessedScans(tx, workspaces[0]!, [currentVerdict])
      expect(assessed.unverified).toEqual(new Set())
      expect(
        await findMismatchedGateEvidence(tx, workspaces[0]!, [currentVerdict], assessed.verified)
      ).toEqual(new Set())
      const fake = { ...currentVerdict, state: "NOT_READY" }
      expect(
        await findMismatchedGateEvidence(tx, workspaces[0]!, [fake], assessed.verified)
      ).toEqual(new Set([targets[0]]))
    } finally {
      await runtime.query("ROLLBACK")
    }
  })

  it("accepts bound evidence, rejects untrusted evidence and isolates workspaces under real RLS", async () => {
    await runtime.query("BEGIN ISOLATION LEVEL REPEATABLE READ")
    try {
      const tx = { $queryRaw: raw } as unknown as ScopedTransaction
      await runtime.query("SELECT set_config('app.current_workspace_id',$1,true)", [workspaces[0]])
      const verdicts = [
        {
          targetId: targets[0]!,
          scanId: `retest-0-${suffix}`,
          evidenceSummary: summary,
          blockingReasons: [],
        },
        {
          targetId: targets[1]!,
          scanId: `retest-1-${suffix}`,
          evidenceSummary: zero,
          blockingReasons: [],
        },
      ]
      calls = 0
      expect(await findMismatchedGateEvidence(tx, workspaces[0]!, verdicts)).toEqual(new Set())
      expect(rowsSeen).toEqual([targets[0]])
      expect(calls).toBe(5)
      expect(await findMismatchedGateEvidence(tx, workspaces[1]!, [verdicts[1]!])).toEqual(
        new Set()
      )
      expect(rowsSeen).toEqual([])
      await runtime.query("SELECT set_config('app.current_workspace_id',$1,true)", [workspaces[1]])
      expect(
        await findMismatchedGateEvidence(tx, workspaces[1]!, [
          { ...verdicts[1]!, evidenceSummary: summary },
        ])
      ).toEqual(new Set([targets[1]]))
      expect(rowsSeen).toEqual([targets[1]])
    } finally {
      await runtime.query("ROLLBACK")
    }
  })
})
