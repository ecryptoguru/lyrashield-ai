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
