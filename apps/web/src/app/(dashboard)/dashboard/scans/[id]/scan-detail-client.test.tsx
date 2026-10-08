import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

import { WebMcpReceiptProvider } from "@/components/webmcp/webmcp-receipt-provider"
import { ScanDetailClient } from "./scan-detail-client"
import type { FindingItem, ScanData } from "./scan-detail-types"
import { getScanModeLabel } from "@/lib/enum-labels"

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

function renderDetail(props: {
  scan: ScanData
  findings: FindingItem[]
  scorecard?: React.ComponentProps<typeof ScanDetailClient>["scorecard"]
  canCancel?: boolean
}) {
  // The dashboard layout guarantees the WebMCP receipt provider — render
  // inside it, matching the component's real runtime contract.
  return renderToString(
    <WebMcpReceiptProvider>
      <ScanDetailClient
        scan={props.scan}
        findings={props.findings}
        scorecard={props.scorecard ?? null}
        canCancel={props.canCancel ?? false}
      />
    </WebMcpReceiptProvider>
  ).replaceAll("<!-- -->", "")
}

const html = renderDetail({ scan, findings: [finding] })

describe("scan detail badge labels", () => {
  it("labels UTC timestamps on the scan detail page", () => {
    expect(html).toContain("completed Jan 1, 2026, 00:05 UTC")

    const eventHtml = renderDetail({
      scan: {
        ...scan,
        events: [
          {
            id: "event-1",
            stage: "worker",
            level: "info",
            message: "Started scan",
            createdAt: "2026-01-01T00:03:00.000Z",
          },
        ],
      },
      findings: [],
    })
    expect(eventHtml).toContain("00:03 UTC")
  })

  it("uses the same goal label as the scan list", () => {
    for (const [goal, label] of [
      ["CHECK_PR", "Check a PR"],
      ["SECURITY_REVIEW", "Security scan"],
      ["FUTURE_REVIEW", "Future review"],
    ] as const) {
      const html = renderDetail({ scan: { ...scan, goal }, findings: [] })
      expect(html).toContain(label)
    }
  })

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

describe("scan detail guided states", () => {
  const target = {
    id: "target-1",
    name: "Checkout API",
    type: "API",
    url: "https://api.example.test",
    repoFullName: null,
  }

  it("keeps a running scan non-assuring and offers a read-only refresh", () => {
    const html = renderDetail({
      scan: {
        ...scan,
        status: "RUNNING",
        endedAt: null,
        target,
        integrity: { ...scan.integrity, coverage: [] },
      },
      findings: [],
    })

    expect(html).toContain("Scan in progress")
    expect(html).toContain("Refresh status")
    expect(html).toContain("This does not start another scan.")
    expect(html).toContain('Target: </span><span class="font-medium">Checkout API')
    expect(html).not.toContain("Create an assurance report")
  })

  it("shows a same-target coverage action alongside retained findings", () => {
    const html = renderDetail({
      scan: {
        ...scan,
        status: "PARTIAL",
        target,
        integrity: {
          ...scan.integrity,
          coverage: [
            {
              scanner: "sca",
              controlId: "sca-review",
              status: "PARTIAL",
              reason: "The configured source was only partly available.",
              subject: null,
              metadata: null,
            },
          ],
        },
      },
      findings: [finding],
    })

    expect(html).toContain("Coverage: Partial")
    expect(html).toContain("Coverage is partial or has a recorded limitation.")
    expect(html).toContain("Complete coverage")
    expect(html).toContain(
      "/dashboard/scans?new=1&amp;target=target-1&amp;goal=TEST_APP&amp;mode=STANDARD"
    )
    expect(html).not.toContain("Create an assurance report")
  })

  it("offers a scan-scoped report only after completed applicable coverage with no findings", () => {
    const html = renderDetail({
      scan: {
        ...scan,
        target,
        integrity: {
          ...scan.integrity,
          coverage: [
            {
              scanner: "sca",
              controlId: "sca-review",
              status: "COMPLETED",
              reason: null,
              subject: null,
              metadata: null,
            },
          ],
        },
      },
      findings: [],
      scorecard: { targetId: target.id, grade: "A", canPublish: true },
    })

    expect(html).toContain("Coverage: Complete")
    expect(html).toContain("Create an assurance report")
    expect(html).toContain("/dashboard/reports?scanId=scan-1&amp;targetId=target-1")
    expect(html).toContain("Share this review")
    expect(html).toContain("Create public scorecard")
    expect(html).toContain("Absence of findings is not verification.")
  })

  it("withholds report and scorecard actions for a partial clean result", () => {
    const html = renderDetail({
      scan: { ...scan, status: "PARTIAL", target },
      findings: [],
      scorecard: { targetId: target.id, grade: "A", canPublish: true },
    })

    expect(html).not.toContain("Create an assurance report")
    expect(html).not.toContain("Share this review")
    expect(html).not.toContain("Create public scorecard")
  })

  it("uses a human target type label", () => {
    const html = renderDetail({
      scan: {
        ...scan,
        target: { id: "target-1", name: "Repo", type: "REPO", url: null, repoFullName: null },
      },
      findings: [],
    })

    expect(html).toContain("Repository")
    expect(html).not.toContain(">REPO<")
  })

  it("routes an exhausted-minutes result to account usage instead of retrying", () => {
    const html = renderDetail({
      scan: {
        ...scan,
        status: "STOPPED_BUDGET",
        errorCategory: "AGENT_MINUTES_EXHAUSTED",
        target,
      },
      findings: [],
    })

    expect(html).toContain("Review account usage")
    expect(html).toContain("/dashboard/billing")
    expect(html).not.toContain("Start a new scan")
  })
})

/**
 * W1/P2-5 — a scan waiting for approval rendered the animated in-progress card
 * with an estimate and a "most scans finish sooner" promise, and no way to
 * reach the queue it was waiting in. No scan detail page offered Cancel.
 */
describe("scan detail — approval and cancellation (W1/P2-5)", () => {
  const activeScan = (overrides: Partial<ScanData> = {}): ScanData => ({
    ...scan,
    status: "REQUIRES_APPROVAL",
    endedAt: null,
    target: null,
    integrity: { ...scan.integrity, coverage: [] },
    ...overrides,
  })

  it("does not describe a scan waiting on a human as scanning", () => {
    const html = renderDetail({ scan: activeScan(), findings: [] })

    expect(html).toContain("Scan needs approval")
    expect(html).not.toContain("Most scans finish sooner")
    expect(html).not.toContain("Estimated time")
    expect(html).toContain("Scan work has not started.")
  })

  it("links to the approval queue", () => {
    const html = renderDetail({ scan: activeScan(), findings: [] })

    expect(html).toContain('href="/dashboard/approvals"')
    expect(html).toContain("Open the approval queue")
  })

  it("offers no cancel control without the cancel permission", () => {
    const html = renderDetail({ scan: activeScan(), findings: [] })

    expect(html).not.toContain("Cancel this scan")
  })

  it("offers a confirm-gated cancel for an active scan when permitted", () => {
    const html = renderDetail({ scan: activeScan(), findings: [], canCancel: true })

    expect(html).toContain("Cancel this scan")
    expect(html).toContain("Stop scan")
  })

  it("offers no cancel control for a scan that already ended", () => {
    const html = renderDetail({
      scan: activeScan({ status: "COMPLETED", endedAt: "2026-01-01T00:05:00.000Z" }),
      findings: [],
      canCancel: true,
    })

    expect(html).not.toContain("Cancel this scan")
  })
})

describe("scan detail accounting events", () => {
  it("keeps billing settlement internals out of the user timeline", () => {
    const html = renderDetail({
      scan: {
        ...scan,
        events: [
          {
            id: "settlement-intent-1",
            stage: "billing_settlement_intent",
            level: "info",
            message: "Settlement intent; missing usage receipt requires terminal accounting review",
            metadata: null,
            createdAt: "2026-01-01T00:05:00.000Z",
          },
        ],
      },
      findings: [],
    })

    expect(html).not.toContain("billing_settlement_intent")
    expect(html).not.toContain("terminal accounting review")
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
  const plannedHtml = renderDetail({ scan: plannedScan, findings: [] })

  it("renders the recorded workflow, depth, scope, limits, and attachments", () => {
    expect(plannedHtml).toContain("Scope and plan")
    expect(plannedHtml).toContain("Scan changes")
    // Depth renders through the scan-mode label map, not the raw enum value.
    expect(plannedHtml).toContain(`>${getScanModeLabel("QUICK")}<`)
    expect(plannedHtml).not.toContain(">QUICK<")
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
    const failedHtml = renderDetail({
      scan: {
        ...scan,
        status: "FAILED",
        errorCategory: "SCAN_ATTACHMENT_UNAVAILABLE",
        errorMessage: "A supporting file could not be verified",
      },
      findings: [],
    })
    expect(failedHtml).toContain("Supporting file unavailable")
    expect(failedHtml).not.toContain("Clean")
  })
})
