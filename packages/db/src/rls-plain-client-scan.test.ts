import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Deep Review v16 2.2: a static tripwire for the call-site class of RLS bug.
 *
 * The v16 review found the same omission twice (billing-reconciliation and
 * the license renewal route): a FORCE-RLS model read through the plain
 * `prisma` client in a context with NO workspace binding at all — a worker
 * cron job with no request context and no workspaceId in the query args.
 * Under the runtime role those reads either fail closed to zero rows (strict
 * policies — every paid order flagged "webhook may have been missed") or,
 * on tables whose policy still has the permissive
 * `app.current_workspace_id() IS NULL` arm, silently read ACROSS tenants.
 * No policy-level test can catch a call-site omission, so this scans source
 * for the shape instead.
 *
 * Rule: any direct `prisma.<forceRlsModel>.<read>` (the client accessor is
 * camelCase — prisma.webhookEvent, not prisma.WebhookEvent) in a file that
 * references NONE of the explicit RLS-context mechanisms fails CI. The
 * mechanisms:
 *   - withWorkspaceRLS — transaction-local RLS GUC for multi-statement reads
 *   - runWithDatabaseRLSContext — binds the extension's RLS wrap explicitly
 *   - getSystemPrisma — deliberate cross-workspace system operation
 *
 * Files that rely on the Prisma workspace EXTENSION (auto-wrapping reads in
 * a SET LOCAL transaction when a request context or explicit workspaceId
 * exists) are grandfathered in the ALLOWLIST below with the justification.
 * The tripwire's job is to stop NEW marker-less files from gaining plain
 * FORCE-RLS reads, which is exactly the 1.4 bug shape: a new file, no
 * context mechanism, a plain read that silently reads nothing or everything.
 *
 * Heuristic, deliberately narrow: plain-client property access only. Raw
 * SQL and transactional `tx.` clients are out of scope — `tx` is only
 * obtainable through withWorkspaceRLS or a $transaction whose own file is
 * checked the same way. Tests and the generated Prisma client are excluded.
 */

// camelCase client accessors for the FORCE-RLS tables (migrations
// 20260705100000 batch3, 20260721033000 strict, the child-table batch,
// 20260902100000 GateVerdict, 20260903100000 License family, plus
// agent_connections/agent_operations/loop_closures).
const FORCE_RLS_ACCESSORS = new Set([
  // Workspace-scoped (own workspaceId column)
  "apiKey",
  "auditLog",
  "billingAccount",
  "credentialSet",
  "finding",
  "integration",
  "invitation",
  "minutePack",
  "notification",
  "policy",
  "project",
  "report",
  "schedule",
  "scan",
  "target",
  "ticket",
  "usageRecord",
  "webhookEvent",
  "scoreSnapshot",
  "findingCandidate",
  "findingVerification",
  "aiSystemProfile",
  "threatModel",
  "controlEvidence",
  "aiSecurityScoreSnapshot",
  "targetDomainVerification",
  "liveAiSafetySettings",
  "liveAiSafetyPlan",
  "liveAiSafetyRun",
  "gateVerdict",
  "agentConnection",
  "agentOperation",
  "loopClosure",
  // Child tables (RLS via parent's workspaceId; no own column)
  "agentApproval",
  "retest",
  "evidence",
  "fixProposal",
  "pullRequest",
  "scanEvent",
  "scanCoverageReceipt",
  "scanResultManifest",
  "scorecardShare",
  "scorecardEvent",
  "aiSystemProfileVersion",
  "threatModelVersion",
  "controlEvidenceVersion",
  "license",
  "licenseActivation",
  "licenseKey",
  "licenseRevocation",
  "syncCursor",
])

const RLS_CONTEXT_MARKERS = [
  "withWorkspaceRLS",
  "runWithDatabaseRLSContext",
  "getSystemPrisma",
] as const

/**
 * Grandfathered files: plain-client FORCE-RLS reads that rely on the Prisma
 * workspace extension (request context or explicit workspaceId in the query
 * args auto-wraps the read in a SET LOCAL transaction), or are deliberate
 * cross-workspace sweeps reviewed as system-shaped. Each entry names the
 * models read so a file that gains a NEW model here is still visible in
 * review. Verified 2026-09-10 against the branch; the 1.4 offenders were
 * fixed in the reconciliation job and the license renew route before this
 * list was built.
 */
const ALLOWLIST: Record<string, string> = {
  // P1-7 (billing-downgrade.job.ts) was CONVERTED, not allowlisted: the
  // downgrade sweep now reads through getSystemPrisma (marker present). P1-8
  // (schedules.ts) was fixed by passing workspaceId explicitly on the guard
  // count; its remaining reads stay extension-wrapped below.
  "apps/worker/src/engine/deterministic-retest.ts":
    "retest/findingCandidate/scanResultManifest/scanCoverageReceipt reads with explicit workspaceId args (extension-wrapped)",
  "apps/worker/src/jobs/preflight.job.ts":
    "target/scan reads with explicit workspaceId or bare-id lookups inside the scan pipeline (extension-wrapped)",
  "apps/worker/src/schedules.ts":
    "scan counts and schedule updates with explicit workspaceId args (extension-wrapped; the P1-8 guard count passes workspaceId explicitly — regression-tested in worker-rls-regressions.runtime.test.ts)",
  "packages/billing/src/entitlements.ts":
    "billingAccount/usageRecord/target reads with explicit workspaceId args (extension-wrapped)",
  "packages/billing/src/usage/balance.ts":
    "billingAccount/minutePack/usageRecord reads with explicit workspaceId args (extension-wrapped)",
  "packages/billing/src/usage/grants.ts":
    "usageRecord read with explicit workspaceId args (extension-wrapped)",
  "packages/billing/src/webhook-tracks.ts":
    "webhookEvent track ledger — cross-workspace by design (reviewed with the 1.4 fix)",
  "packages/db/src/agent-approval-service.ts":
    "agentApproval reads with explicit workspaceId args (extension-wrapped)",
  "packages/db/src/api-key-service.ts":
    "apiKey reads with explicit workspaceId args (extension-wrapped)",
  "packages/db/src/finding-service.ts":
    "finding/evidence/verification/proposal/retest reads with explicit workspaceId args (extension-wrapped)",
  "packages/db/src/notification-service.ts":
    "notification reads with explicit workspaceId args (extension-wrapped)",
  "packages/db/src/report-generator.ts":
    "scan/finding/scoreSnapshot reads with explicit workspaceId args (extension-wrapped)",
  "packages/db/src/retest-service.ts":
    "finding/scan/retest reads with explicit workspaceId args (extension-wrapped)",
}

const READ_OPS = ["findMany", "findFirst", "findUnique", "count", "aggregate", "groupBy"]

// __dirname-relative (the terminology test precedent): the scan must not
// depend on the runner's working directory. From packages/db/src: two levels
// up is packages/ (billing lives at packages/billing), three levels up is
// the repo root (apps/worker).
const ROOTS = [
  __dirname, // packages/db/src
  join(__dirname, "..", "..", "billing", "src"),
  join(__dirname, "..", "..", "..", "apps", "worker", "src"),
] as const

// The generated Prisma client is thousands of files and matches every
// pattern; the eslint config ignores it for the same reason.
const SKIP_DIRS = new Set(["generated", "dist", "node_modules", ".turbo"])

/** Raw line scan over source text: returns offender descriptions. */
function scanSource(source: string): string[] {
  const offenders: string[] = []
  const lines = source.split("\n")
  for (const [index, line] of lines.entries()) {
    for (const accessor of FORCE_RLS_ACCESSORS) {
      for (const op of READ_OPS) {
        if (line.includes(`prisma.${accessor}.${op}(`)) {
          offenders.push(`line ${index + 1} prisma.${accessor}.${op}`)
        }
      }
    }
  }
  return offenders
}

function scanFile(path: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = readFileSync(path, "utf8")
  if (RLS_CONTEXT_MARKERS.some((marker) => source.includes(marker))) return []
  const prefix = relative(join(__dirname, "..", "..", ".."), path)
  return scanSource(source).map((hit) => `${prefix}:${hit}`)
}

function collect(root: string, files: string[] = []): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of readdirSync(root)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(root, entry)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (statSync(full).isDirectory()) {
      collect(full, files)
    } else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) {
      files.push(full)
    }
  }
  return files
}

describe("plain-client FORCE-RLS reads (v16 2.2 tripwire)", () => {
  it("fails when a FORCE-RLS model is read through the plain client in a new file with no RLS context", () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of collect(root)) {
        for (const hit of scanFile(file)) {
          const fileRef = hit.split(":")[0] ?? ""
          if (!ALLOWLIST[fileRef]) offenders.push(hit)
        }
      }
    }
    expect(
      offenders,
      `plain-client FORCE-RLS reads with no RLS context and no ALLOWLIST entry (add withWorkspaceRLS, runWithDatabaseRLSContext or getSystemPrisma — or justify in this test's ALLOWLIST):\n${offenders.join("\n")}`
    ).toEqual([])
  })

  it("the tripwire itself detects the historical bug shape", () => {
    // Self-check: the exact v16 1.4 offender shape (billing reconciliation's
    // WebhookEvent read — camelCase client accessor) must be caught by the
    // scanner, proving the test cannot silently rot into a no-op. The first
    // version of this scan matched PascalCase model names and was blind.
    const historicalBugShape = [
      'import { prisma } from "./client"',
      "",
      "export async function historicalBugShape() {",
      '  return prisma.webhookEvent.findMany({ where: { provider: "polar" } })',
      "}",
      "",
    ].join("\n")
    const offenders = scanSource(historicalBugShape)
    expect(offenders.join("\n")).toContain("prisma.webhookEvent.findMany")
  })

  it("the allowlist stays honest: every entry still exists on disk", () => {
    for (const fileRef of Object.keys(ALLOWLIST)) {
      const fullPath = join(__dirname, "..", "..", "..", fileRef)
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      expect(statSync(fullPath).isFile(), `${fileRef} no longer exists — prune the ALLOWLIST`).toBe(
        true
      )
    }
  })
})
