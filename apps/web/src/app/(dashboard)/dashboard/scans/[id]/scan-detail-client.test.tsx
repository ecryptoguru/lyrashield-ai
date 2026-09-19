import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

import { ScanDetailClient } from "./scan-detail-client"
import type { FindingItem, ScanData } from "./scan-detail-types"

const scan: ScanData = {
  id: "scan-1",
  workspaceId: "ws-1",
  status: "COMPLETED",
  goal: "TEST_APP",
  mode: "STANDARD",
  triggerType: "manual",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:05:00.000Z",
  summary: null,
  errorCategory: null,
  errorMessage: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  target: null,
  events: [],
  executionPlan: null,
  integrity: {
    manifestChecksum: "abc123",
    coverage: [
      {
        scanner: "deps",
        controlId: "deps-audit",
        status: "NOT_APPLICABLE",
        reason: null,
        subject: null,
        metadata: null,
      },
      {
        scanner: "vibe",
        controlId: "vibe-auth",
        status: "COMPLETED",
        reason: null,
        subject: null,
        metadata: { outcome: "NO_FINDING", title: "Auth review", rank: 1 },
      },
    ],
  },
  aiSecurity: null,
}

const finding: FindingItem = {
  id: "finding-1",
  title: "Example finding",
  severity: "HIGH",
  status: "OPEN",
  cwe: null,
  cvssScore: null,
  summary: null,
  verified: false,
  verificationStatus: "VERIFIED",
  verificationMethod: null,
  verificationReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
}

const html = renderToString(<ScanDetailClient scan={scan} findings={[finding]} scorecard={null} />)

describe("scan detail badge labels", () => {
  it("humanises the coverage receipt status and control outcome badges", () => {
    expect(html).toContain(">Not applicable<")
    expect(html).toContain(">No finding<")
    expect(html).not.toContain("NOT APPLICABLE")
    expect(html).not.toContain("NOT_APPLICABLE")
    expect(html).not.toContain("NO FINDING")
    expect(html).not.toContain("NO_FINDING")
  })

  it("labels verification state through the verification label map", () => {
    expect(html).toContain("Independently verified")
    expect(html).not.toContain(">VERIFIED<")
  })
})

describe("scan detail — truthful scope and declared coverage", () => {
  const plannedScan: ScanData = {
    ...scan,
    executionPlan: {
      workflow: "REVIEW_CHANGES",
      targetType: "REPO",
      depth: "QUICK",
      scope: "DIFF",
      profileId: "repo-quick",
      sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxDurationMinutes: 15,
      maxRequests: null,
      attachmentCount: 2,
      authorizationRequired: false,
      capabilities: ["engine", "secrets", "sca"],
    },
    integrity: {
      ...scan.integrity,
      scopedCoverage: {
        entries: [{ id: "scope-1", subject: "src/auth", outcome: "no_issue_found" }],
        gaps: [{ kind: "unreachable", detail: "vendor/ directory not analyzed" }],
        completeness: { complete: false, caveats: ["coverage.json declared partial scope"] },
      },
      threatModel: {
        checksum: "c".repeat(64),
        byteLength: 2048,
        modelCount: 1,
        entries: [{ target: "checkout", preview: "Attacker controls cart input" }],
      },
      attachments: { count: 2, totalBytes: 4096, manifestChecksum: "d".repeat(64) },
      ingestionWarnings: ["coverage.json exceeded the entry cap; tail dropped"],
    },
  }
  const plannedHtml = renderToString(
    <ScanDetailClient scan={plannedScan} findings={[]} scorecard={null} />
  )

  it("renders the recorded workflow, depth, scope, limits, and attachments", () => {
    expect(plannedHtml).toContain("Scope and plan")
    expect(plannedHtml).toContain("Review changes")
    expect(plannedHtml).toContain("Recorded diff")
    expect(plannedHtml).toContain("bbbbbbb") // truncated base revision
    expect(plannedHtml).toContain("Up to 15 minutes")
    expect(plannedHtml).toContain("2 recorded inputs")
    // The plan card never carries provider routing or cost internals.
    expect(plannedHtml).not.toMatch(/maxBudgetUsd|providerCost|USD/)
  })

  it("renders engine-declared coverage and threat-model entries under disclosure", () => {
    expect(plannedHtml).toContain("Declared coverage and inputs")
    expect(plannedHtml).toContain("Requested vs achieved coverage")
    expect(plannedHtml).toContain("src/auth")
    expect(plannedHtml).toContain("vendor/ directory not analyzed")
    expect(plannedHtml).toContain("coverage.json declared partial scope")
    expect(plannedHtml).toContain("Threat-model assumptions")
    expect(plannedHtml).toContain("Attacker controls cart input")
    expect(plannedHtml).toContain("engine&#x27;s own assertions")
  })

  it("renders the attachment staging receipt and ingestion warnings", () => {
    expect(plannedHtml).toContain("staged read-only")
    expect(plannedHtml).toContain("dddddddddddd") // truncated manifest checksum
    expect(plannedHtml).toContain("evidence ingestion issue")
  })

  it("names an attachment verification failure instead of a generic crash", () => {
    const failedHtml = renderToString(
      <ScanDetailClient
        scan={{
          ...scan,
          status: "FAILED",
          errorCategory: "SCAN_ATTACHMENT_UNAVAILABLE",
          errorMessage: "A supporting file could not be verified",
        }}
        findings={[]}
        scorecard={null}
      />
    )
    expect(failedHtml).toContain("Supporting file unavailable")
    expect(failedHtml).not.toContain("Clean")
  })
})
