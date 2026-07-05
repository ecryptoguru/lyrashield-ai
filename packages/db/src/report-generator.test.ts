import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    workspace: {
      findFirst: vi.fn(),
    },
    scan: {
      findFirst: vi.fn(),
    },
    finding: {
      findMany: vi.fn(),
    },
  },
}))

import { prisma } from "./client"
import { gatherReportData, generateReportHTML } from "./report-generator"

const mockPrisma = prisma as unknown as {
  workspace: { findFirst: ReturnType<typeof vi.fn> }
  scan: { findFirst: ReturnType<typeof vi.fn> }
  finding: { findMany: ReturnType<typeof vi.fn> }
}

describe("report-generator", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("gatherReportData", () => {
    it("gathers report data without scanId", async () => {
      mockPrisma.workspace.findFirst.mockResolvedValue({ name: "Acme Inc" })
      mockPrisma.finding.findMany.mockResolvedValue([])

      const data = await gatherReportData("ws-1")

      expect(data.workspaceName).toBe("Acme Inc")
      expect(data.scanInfo).toBeNull()
      expect(data.totalFindings).toBe(0)
      expect(data.findings).toHaveLength(0)
    })

    it("gathers report data with scanId", async () => {
      mockPrisma.workspace.findFirst.mockResolvedValue({ name: "Acme Inc" })
      mockPrisma.scan.findFirst.mockResolvedValue({
        id: "scan-1",
        status: "completed",
        summary: "Full scan",
        target: { name: "example.com", type: "url", url: "https://example.com" },
        startedAt: new Date("2026-01-01"),
        endedAt: new Date("2026-01-02"),
      })
      mockPrisma.finding.findMany.mockResolvedValue([
        {
          id: "f-1",
          title: "XSS",
          severity: "HIGH",
          status: "OPEN",
          verified: true,
          confidence: "high",
          cwe: "CWE-79",
          cvssScore: 7.5,
          category: "injection",
          summary: "Reflected XSS found",
          exploitability: "high",
          recommendedFix: "Sanitize input",
          fixProposals: [{ id: "fp-1", status: "draft" }],
          retests: [{ id: "rt-1", status: "failed" }],
        },
        {
          id: "f-2",
          title: "SQLi",
          severity: "CRITICAL",
          status: "FIXED",
          verified: true,
          confidence: "high",
          cwe: "CWE-89",
          cvssScore: 9.8,
          category: "injection",
          summary: "SQL injection",
          exploitability: "high",
          recommendedFix: "Use prepared statements",
          fixProposals: [{ id: "fp-2", status: "pr_merged" }],
          retests: [{ id: "rt-2", status: "passed" }],
        },
      ])

      const data = await gatherReportData("ws-1", "scan-1")

      expect(data.scanInfo).not.toBeNull()
      expect(data.scanInfo?.targetName).toBe("example.com")
      expect(data.totalFindings).toBe(2)
      expect(data.verifiedCount).toBe(2)
      expect(data.fixedCount).toBe(1)
      expect(data.retestSummary.passed).toBe(1)
      expect(data.retestSummary.failed).toBe(1)
      expect(data.findingsBySeverity["HIGH"]).toBe(1)
      expect(data.findingsBySeverity["CRITICAL"]).toBe(1)
      expect(data.findings[0]!.severity).toBe("CRITICAL")
      expect(data.findings[1]!.severity).toBe("HIGH")
    })
  })

  describe("generateReportHTML", () => {
    it("generates valid HTML with findings", () => {
      const html = generateReportHTML({
        title: "Test Report",
        type: "developer",
        workspaceName: "Test Workspace",
        scanInfo: null,
        findings: [
          {
            id: "f-1",
            title: "XSS Vulnerability",
            severity: "HIGH",
            status: "OPEN",
            verified: true,
            confidence: "high",
            cwe: "CWE-79",
            cvssScore: 7.5,
            category: "injection",
            summary: "Reflected XSS in search parameter",
            exploitability: "high",
            recommendedFix: "Sanitize user input",
            fixStatus: "draft",
            retestStatus: "failed",
          },
        ],
        findingsBySeverity: { HIGH: 1 },
        totalFindings: 1,
        verifiedCount: 1,
        fixedCount: 0,
        retestSummary: { passed: 0, failed: 1, pending: 0 },
        findingsTruncated: false,
        generatedAt: new Date("2026-07-06"),
      })

      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("Test Report")
      expect(html).toContain("XSS Vulnerability")
      expect(html).toContain("CWE-79")
      expect(html).toContain("Total Findings")
      expect(html).toContain(">1<")
    })

    it("generates HTML with no findings", () => {
      const html = generateReportHTML({
        title: "Empty Report",
        type: "developer",
        workspaceName: "Test",
        scanInfo: null,
        findings: [],
        findingsBySeverity: {},
        totalFindings: 0,
        verifiedCount: 0,
        fixedCount: 0,
        retestSummary: { passed: 0, failed: 0, pending: 0 },
        findingsTruncated: false,
        generatedAt: new Date("2026-07-06"),
      })

      expect(html).toContain("No findings")
    })

    it("escapes HTML in user content", () => {
      const html = generateReportHTML({
        title: "Test",
        type: "developer",
        workspaceName: "Test",
        scanInfo: null,
        findings: [
          {
            id: "f-1",
            title: "<script>alert('xss')</script>",
            severity: "HIGH",
            status: "OPEN",
            verified: true,
            confidence: "high",
            cwe: null,
            cvssScore: null,
            category: null,
            summary: "<img onerror=alert(1)>",
            exploitability: null,
            recommendedFix: null,
            fixStatus: "none",
            retestStatus: null,
          },
        ],
        findingsBySeverity: { HIGH: 1 },
        totalFindings: 1,
        verifiedCount: 1,
        fixedCount: 0,
        retestSummary: { passed: 0, failed: 0, pending: 0 },
        findingsTruncated: false,
        generatedAt: new Date("2026-07-06"),
      })

      expect(html).not.toContain("<script>alert")
      expect(html).toContain("&lt;script&gt;")
      expect(html).not.toContain("<img onerror")
    })
  })
})
