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
    scoreSnapshot: {
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
  scoreSnapshot: { findMany: ReturnType<typeof vi.fn> }
}

describe("report-generator", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.scoreSnapshot.findMany.mockResolvedValue([])
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
      expect(data.version).toBe(2)
      expect(data.assurance?.verdict).toBe("NOT_EVALUATED")
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
        targetId: "target-1",
        resultManifest: { checksum: "manifest-checksum" },
        coverageReceipts: [
          { controlId: "engine", status: "COMPLETED" },
          { controlId: "vibe-03", status: "COMPLETED" },
          { controlId: "vibe-14", status: "BLOCKED" },
          { controlId: "vibe-50", status: "NOT_APPLICABLE" },
        ],
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
          firstSeenAt: new Date("2025-12-01"),
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
          firstSeenAt: new Date("2025-11-01"),
          fixProposals: [{ id: "fp-2", status: "pr_merged" }],
          retests: [{ id: "rt-2", status: "passed" }],
        },
      ])
      mockPrisma.scoreSnapshot.findMany.mockResolvedValue([
        { score: 62, grade: "C", computedAt: new Date("2026-01-02") },
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
      expect(data.assurance?.score).toBe(62)
      expect(data.assurance?.verdict).toBe("NO_GO")
      expect(data.findingsByStatus).toEqual({ FIXED: 1, OPEN: 1 })
      expect(data.findingsByCategory).toEqual({ injection: 2 })
      expect(data.scanInfo?.coverage).toEqual({ completed: 1, limited: 1, notApplicable: 1 })
    })

    it("includes urlExecution from the result manifest", async () => {
      mockPrisma.workspace.findFirst.mockResolvedValue({ name: "Acme Inc" })
      mockPrisma.scan.findFirst.mockResolvedValue({
        id: "scan-1",
        status: "completed",
        summary: "URL scan",
        target: { name: "example.com", type: "WEB_APP", url: "https://example.com" },
        startedAt: new Date("2026-01-01"),
        endedAt: new Date("2026-01-02"),
        targetId: "target-1",
        resultManifest: {
          checksum: "manifest-checksum",
          manifest: {
            urlExecution: {
              contractVersion: "url-scan/2.0.0",
              profile: "WEB_APP_STANDARD",
              methods: ["GET"],
              subjectCount: 17,
              documentCount: 10,
              assetCount: 7,
              operationCount: 0,
              methodProbeCount: 0,
              originProbeCount: 0,
              totalBytes: 2048,
              truncated: true,
              issueCodes: ["LIMIT_REACHED"],
            },
          },
        },
        coverageReceipts: [],
      })
      mockPrisma.finding.findMany.mockResolvedValue([])
      mockPrisma.scoreSnapshot.findMany.mockResolvedValue([])

      const data = await gatherReportData("ws-1", "scan-1")

      expect(data.scanInfo?.urlExecution).toEqual({
        contractVersion: "url-scan/2.0.0",
        profile: "WEB_APP_STANDARD",
        methods: ["GET"],
        subjectCount: 17,
        documentCount: 10,
        assetCount: 7,
        operationCount: 0,
        methodProbeCount: 0,
        originProbeCount: 0,
        totalBytes: 2048,
        truncated: true,
        issueCodes: ["LIMIT_REACHED"],
      })
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
        findingsByStatus: { OPEN: 1 },
        findingsByCategory: { injection: 1 },
        assurance: {
          verdict: "GO_WITH_CONDITIONS",
          score: 72,
          grade: "B",
          narrative: "One high-severity finding remains.",
          scoreTrend: [],
          ageBuckets: { "0–7 days": 1 },
          priorityActions: [
            { label: "Assign remediation", detail: "Set an owner and due date.", severity: "HIGH" },
          ],
          methodology: ["Frozen at report creation time."],
        },
      })

      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("Test Report")
      expect(html).toContain("XSS Vulnerability")
      expect(html).toContain("CWE-79")
      expect(html).toContain("Total Findings")
      expect(html).toContain(">1<")
      expect(html).toContain("Assurance verdict")
      expect(html).toContain("Priority Actions")
      expect(html).toContain("Methodology and Limits")
    })

    it("renders URL execution scope and limitations in report HTML", () => {
      const html = generateReportHTML({
        title: "URL Scan Report",
        type: "developer",
        workspaceName: "Test Workspace",
        scanInfo: {
          scanId: "scan-1",
          status: "COMPLETED",
          summary: null,
          targetName: "example.com",
          targetType: "WEB_APP",
          targetUrl: "https://example.com",
          startedAt: new Date("2026-01-01"),
          endedAt: new Date("2026-01-02"),
          manifestChecksum: "checksum",
          coverage: { completed: 1, limited: 0, notApplicable: 0 },
          urlExecution: {
            contractVersion: "url-scan/2.0.0",
            profile: "WEB_APP_STANDARD",
            methods: ["GET"],
            subjectCount: 17,
            documentCount: 10,
            assetCount: 7,
            operationCount: 0,
            methodProbeCount: 0,
            originProbeCount: 0,
            totalBytes: 2048,
            truncated: true,
            issueCodes: ["LIMIT_REACHED"],
          },
        },
        findings: [],
        findingsBySeverity: {},
        totalFindings: 0,
        verifiedCount: 0,
        fixedCount: 0,
        retestSummary: { passed: 0, failed: 0, pending: 0 },
        findingsTruncated: false,
        generatedAt: new Date("2026-07-06"),
      })

      expect(html).toContain("URL Execution Scope")
      expect(html).toContain("Expanded Surface Review · 10 pages · 7 assets · GET")
      expect(html).toContain("Coverage limited: LIMIT_REACHED")
      expect(html).toContain("non-mutating review did not authenticate")
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
