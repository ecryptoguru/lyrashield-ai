import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Deep Review v16 2.2: a static tripwire for the call-site class of RLS bug.
 *
 * The v16 review found the same omission twice (billing-reconciliation and
 * the license renewal route): a FORCE-RLS model read through the plain
 * `prisma` client with no workspace context. Under the runtime role those
 * reads either fail closed to zero rows (strict policies — every paid order
 * flagged "webhook may have been missed") or, on tables whose policy still
 * has the permissive `app.current_workspace_id() IS NULL` arm, silently read
 * ACROSS tenants. No policy-level test can catch a call-site omission, so
 * this scans source for the shape instead.
 *
 * Rule: any direct `prisma.<ForceRlsModel>.<read>` must appear in a file that
 * also references one of the RLS-context mechanisms — `withWorkspaceRLS`
 * (transaction-local GUC), `runWithDatabaseRLSContext` (extension context)
 * or `getSystemPrisma` (deliberate cross-workspace system operation).
 *
 * Heuristic, deliberately narrow: it looks for the plain-client property
 * access only. Raw SQL and transactional `tx.` clients are out of scope —
 * `tx` is only obtainable through withWorkspaceRLS or a $transaction whose
 * own file is checked the same way. If a future file legitimately needs a
 * plain-client FORCE-RLS read (a pre-auth lookup like verify_api_key, which
 * is a SECURITY DEFINER function rather than a model read), reference
 * `getSystemPrisma` or `runWithDatabaseRLSContext` in the file, or extend
 * the allowlist below WITH a justification comment.
 */

const FORCE_RLS_MODELS = new Set([
  // Workspace-scoped (own workspaceId column; strict RLS)
  "ApiKey",
  "AuditLog",
  "BillingAccount",
  "CredentialSet",
  "Finding",
  "Integration",
  "Invitation",
  "MinutePack",
  "Notification",
  "Policy",
  "Project",
  "Report",
  "Schedule",
  "Scan",
  "Target",
  "Ticket",
  "UsageRecord",
  "WebhookEvent",
  "ScoreSnapshot",
  "FindingCandidate",
  "FindingVerification",
  "AiSystemProfile",
  "ThreatModel",
  "ControlEvidence",
  "AiSecurityScoreSnapshot",
  "TargetDomainVerification",
  "LiveAiSafetySettings",
  "LiveAiSafetyPlan",
  "LiveAiSafetyRun",
  "GateVerdict",
  "AgentConnection",
  "AgentOperation",
  "LoopClosure",
  // Child tables (RLS via parent's workspaceId; no own column)
  "AgentApproval",
  "Retest",
  "Evidence",
  "FixProposal",
  "PullRequest",
  "ScanEvent",
  "ScanCoverageReceipt",
  "ScanResultManifest",
  "ScorecardShare",
  "ScorecardEvent",
  "AiSystemProfileVersion",
  "ThreatModelVersion",
  "ControlEvidenceVersion",
  "License",
  "LicenseActivation",
  "LicenseKey",
  "LicenseRevocation",
  "SyncCursor",
])

const RLS_CONTEXT_MARKERS = [
  "withWorkspaceRLS",
  "runWithDatabaseRLSContext",
  "getSystemPrisma",
] as const

/**
 * Files with a reviewed, documented reason to read a FORCE-RLS model through
 * the plain client. Each entry must carry its justification here.
 */
const ALLOWLIST: Record<string, string> = {
  // No entries yet. The 1.4 fixes removed the two known offenders.
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

/** Raw line scan over source text: returns offender descriptions. */
function scanSource(source: string): string[] {
  const offenders: string[] = []
  const lines = source.split("\n")
  for (const [index, line] of lines.entries()) {
    for (const model of FORCE_RLS_MODELS) {
      for (const op of READ_OPS) {
        if (line.includes(`prisma.${model}.${op}(`)) {
          offenders.push(`line ${index + 1} prisma.${model}.${op}`)
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
  it("fails when a FORCE-RLS model is read through the plain client with no RLS context", () => {
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
      `plain-client FORCE-RLS reads with no RLS context (add withWorkspaceRLS, runWithDatabaseRLSContext or getSystemPrisma — or justify in this test's ALLOWLIST):\n${offenders.join("\n")}`
    ).toEqual([])
  })

  it("the tripwire itself detects the historical bug shape", () => {
    // Self-check: the exact v16 1.4 offender shape (billing reconciliation's
    // WebhookEvent read) must be caught by the scanner, proving the test
    // cannot silently rot into a no-op. Inlined as a string rather than read
    // from a fixture file — under vitest's transform pipeline a file read by
    // __dirname can resolve to an empty/absent artifact.
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
})
