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

vi.mock("./ai-assurance-service", () => ({
  listControlEvidence: vi.fn().mockResolvedValue([]),
  aiAssuranceStateForVersion: vi.fn().mockReturnValue("EVIDENCE_REQUIRED"),
  AI_ASSURANCE_CONTROL_IDS: [
    "vibe-34",
    "vibe-35",
    "vibe-36",
    "vibe-43",
    "vibe-46",
    "vibe-48",
    "vibe-50",
  ],
}))

vi.mock("./ai-system-profile-service", () => ({
  getAiSystemProfile: vi.fn().mockResolvedValue(null),
}))

vi.mock("./threat-model-service", () => ({
  getThreatModel: vi.fn().mockResolvedValue(null),
}))

import { prisma } from "./client"
import {
  gatherReportData,
  generateReportHTML,
  parseWebMcpAssurance,
  type ReportWebMcpAssurance,
} from "./report-generator"

const mockPrisma = prisma as unknown as {
  workspace: { findFirst: ReturnType<typeof vi.fn> }
  scan: { findFirst: ReturnType<typeof vi.fn> }
  finding: { findMany: ReturnType<typeof vi.fn> }
  scoreSnapshot: { findMany: ReturnType<typeof vi.fn> }
}

const validWebMcpReceipt: ReportWebMcpAssurance = {
  version: "webmcp-assurance/1",
  detectorVersion: "webmcp-assurance/1",
  coverageState: "COMPLETE",
  eligibleFiles: 4,
  scannedFiles: 4,
  scannedBytes: 4096,
  toolDefinitionsFound: 3,
  toolDefinitionsAssessed: 3,
  incompleteDefinitions: 0,
  imperativeDefinitions: 2,
  declarativeDefinitions: 1,
  limitsReached: [],
  inventoryChecksum: "a".repeat(64),
  sourceSelection: {
    eligibleFiles: 4,
    selectedFiles: 4,
    skippedFiles: 0,
    scannedBytes: 4096,
    skippedByReason: { fileLimit: 0, totalByteLimit: 0, oversized: 0, unreadable: 0 },
    limits: {
      maxFiles: 200,
      maxFileBytes: 1048576,
      maxTotalBytes: 10485760,
      maxWalkEntries: 50000,
      maxWalkDepth: 40,
    },
    limitsReached: [],
  },
  toolCounts: {
    byKind: { imperative: 2, declarative: 1 },
    byBehavior: { read: 1, "ui-only": 0, mutation: 2, unknown: 0 },
  },
  exposurePosture: {
    dynamic: 0,
    wildcard: 1,
    explicitSelf: 1,
    explicitTrusted: 0,
    missingOrUnknown: 1,
  },
  confirmationPosture: { mutationTools: 2, unconfirmedMutations: 1 },
  findingsByControl: {
    "WEBMCP-01": 0,
    "WEBMCP-02": 0,
    "WEBMCP-03": 1,
    "WEBMCP-04": 0,
    "WEBMCP-05": 0,
    "WEBMCP-06": 0,
    "WEBMCP-07": 0,
    "WEBMCP-08": 0,
    "WEBMCP-09": 0,
    "WEBMCP-10": 0,
  },
  findingsBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, INFO: 0 },
  representativeRemediation: [
    { controlId: "WEBMCP-03", severity: "HIGH", text: "Constrain tool exposure." },
  ],
  methodology: ["Bounded deterministic source analysis."],
}

describe("report-generator", () => {
  it("rejects malformed WebMCP manifest metadata", () => {
    expect(
      parseWebMcpAssurance({
        version: "webmcp-assurance/1",
        detectorVersion: "webmcp-assurance/1",
        eligibleFiles: -1,
        inventoryChecksum: "not-a-checksum",
      })
    ).toBeNull()
  })

  it("treats legacy and bounded WebMCP receipts as inconclusive", () => {
    const legacy: Record<string, unknown> = { ...validWebMcpReceipt }
    delete legacy.sourceSelection
    delete legacy.coverageState
    expect(parseWebMcpAssurance(legacy)?.coverageState).toBe("INCONCLUSIVE")

    const bounded = {
      ...validWebMcpReceipt,
      sourceSelection: {
        ...validWebMcpReceipt.sourceSelection,
        eligibleFiles: 5,
        selectedFiles: 4,
        skippedFiles: 1,
        skippedByReason: {
          ...validWebMcpReceipt.sourceSelection.skippedByReason,
          fileLimit: 1,
        },
        limitsReached: ["max_files"],
      },
      limitsReached: ["max_files"],
    }
    expect(parseWebMcpAssurance(bounded)?.coverageState).toBe("INCONCLUSIVE")
  })

  it("rejects inconsistent WebMCP source-selection receipts", () => {
    expect(
      parseWebMcpAssurance({
        ...validWebMcpReceipt,
        sourceSelection: { ...validWebMcpReceipt.sourceSelection, skippedFiles: 2 },
      })
    ).toBeNull()
  })

  it("rejects non-allowlisted WebMCP report aggregates", () => {
    expect(
      parseWebMcpAssurance({
        ...validWebMcpReceipt,
        findingsBySeverity: { ...validWebMcpReceipt.findingsBySeverity, UNKNOWN: 1 },
      })
    ).toBeNull()
    expect(
      parseWebMcpAssurance({
        ...validWebMcpReceipt,
        representativeRemediation: [
          { controlId: "WEBMCP-03", severity: "HIGH", text: "x".repeat(241) },
        ],
      })
    ).toBeNull()
  })

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
      expect(data.version).toBe(3)
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
        resultManifest: { checksum: "manifest-checksum", manifest: { version: 5 } },
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
      expect(data.aiAssurance).toBeDefined()
      expect(data.aiAssurance?.controls).toHaveLength(7)
      expect(data.aiAssurance?.controls.every((c) => c.state === "EVIDENCE_REQUIRED")).toBe(true)
      expect(data.webMcpAssurance).toBeUndefined()
    })

    it("freezes allowlisted WebMCP finding aggregates and bounded remediation", async () => {
      const manifestReceipt: Partial<ReportWebMcpAssurance> = { ...validWebMcpReceipt }
      delete manifestReceipt.findingsByControl
      delete manifestReceipt.findingsBySeverity
      delete manifestReceipt.representativeRemediation
      mockPrisma.workspace.findFirst.mockResolvedValue({ name: "Acme Inc" })
      mockPrisma.scan.findFirst.mockResolvedValue({
        id: "scan-webmcp",
        status: "completed",
        summary: "WebMCP scan",
        target: { name: "Private repository", type: "REPO", url: null },
        startedAt: new Date("2026-08-29"),
        endedAt: new Date("2026-08-29"),
        targetId: "target-1",
        resultManifest: {
          checksum: "manifest-v6-checksum",
          manifest: {
            version: 6,
            coverage: [
              { scanner: "ai_app_security", metadata: { webMcpCoverage: manifestReceipt } },
            ],
          },
        },
        coverageReceipts: [],
      })
      mockPrisma.finding.findMany.mockResolvedValue([
        {
          id: "finding-webmcp-03",
          title: "Unsafe or dynamic cross-origin tool exposure",
          severity: "HIGH",
          status: "OPEN",
          verified: false,
          verificationStatus: "DETECTED",
          confidence: "high",
          cwe: "CWE-942",
          cvssScore: null,
          category: "Security Configuration",
          summary: "Wildcard exposure detected.",
          exploitability: null,
          recommendedFix: "Constrain exposedTo to an explicit origin allowlist.",
          firstSeenAt: new Date("2026-08-29"),
          candidates: [{ payload: { id: "WEBMCP-03", findingClass: "webmcp_tool_surface" } }],
          fixProposals: [],
          retests: [],
        },
      ])

      const data = await gatherReportData("ws-1", "scan-webmcp")

      expect(data.scanInfo?.manifestChecksum).toBe("manifest-v6-checksum")
      expect(data.webMcpAssurance?.findingsByControl["WEBMCP-03"]).toBe(1)
      expect(data.webMcpAssurance?.findingsBySeverity.HIGH).toBe(1)
      expect(data.webMcpAssurance?.representativeRemediation).toEqual([
        {
          controlId: "WEBMCP-03",
          severity: "HIGH",
          text: "Constrain exposedTo to an explicit origin allowlist.",
        },
      ])
    })

    it("freezes AI assurance state without exposing private artifact storage URIs", async () => {
      const { listControlEvidence, aiAssuranceStateForVersion } =
        await import("./ai-assurance-service")
      const { getAiSystemProfile } = await import("./ai-system-profile-service")
      const { getThreatModel } = await import("./threat-model-service")
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
        coverageReceipts: [],
      })
      mockPrisma.finding.findMany.mockResolvedValue([])
      mockPrisma.scoreSnapshot.findMany.mockResolvedValue([])
      vi.mocked(listControlEvidence).mockResolvedValue([
        {
          id: "ce-1",
          workspaceId: "ws-1",
          targetId: "target-1",
          controlId: "vibe-34",
          currentVersion: {
            id: "v-1",
            controlEvidenceId: "ce-1",
            version: 1,
            status: "ACCEPTED",
            attestation: "audit log present",
            expiresAt: null,
            artifactManifest: [
              {
                id: "art-1",
                filename: "proof.pdf",
                mediaType: "application/pdf",
                byteLength: 1234,
                storageUri: "s3://lyrashield-bucket/evidence/ws-1/...",
                checksum: "sha-1",
                encryptionKeyRef: "vault/lyrashield-evidence-key/v1",
              },
            ],
            checksum: "sha-version",
            createdById: "user-1",
            createdAt: new Date(),
            reviewedById: null,
            reviewedAt: null,
          } as never,
        },
      ])
      vi.mocked(aiAssuranceStateForVersion).mockImplementation((version) => {
        if (version && (version as { status: string }).status === "ACCEPTED")
          return "EVIDENCE_ACCEPTED"
        return "EVIDENCE_REQUIRED"
      })
      vi.mocked(getAiSystemProfile).mockResolvedValue({
        currentVersion: { id: "profile-v1" },
      } as never)
      vi.mocked(getThreatModel).mockResolvedValue({
        currentVersion: { id: "threat-model-v1" },
      } as never)

      const data = await gatherReportData("ws-1", "scan-1")

      const control = data.aiAssurance?.controls.find((c) => c.controlId === "vibe-34")
      const snapshotEvidence = data.aiAssurance?.evidence.find((c) => c.controlId === "vibe-34")
      expect(data.aiAssurance).toMatchObject({
        version: "ai-assurance/1.0.0",
        profileState: "COMPLETE",
        threatModelState: "CURRENT",
      })
      expect(snapshotEvidence).toMatchObject({
        evidenceVersionId: "v-1",
        state: "EVIDENCE_ACCEPTED",
        expiresAt: null,
      })
      expect(control?.state).toBe("EVIDENCE_ACCEPTED")
      expect(control?.artifacts).toHaveLength(1)
      expect(control?.artifacts[0]?.filename).toBe("proof.pdf")
      expect(control?.artifacts[0]?.byteLength).toBe(1234)
      expect(control?.artifacts[0]).not.toHaveProperty("storageUri")
      expect(control?.artifacts[0]).not.toHaveProperty("encryptionKeyRef")
      expect(data.aiAssurance?.controls).toHaveLength(7)
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

    it("renders versioned WebMCP coverage and checksum without raw source", () => {
      const html = generateReportHTML({
        title: "WebMCP Report",
        type: "developer",
        workspaceName: "Test Workspace",
        scanInfo: null,
        findings: [],
        findingsBySeverity: {},
        totalFindings: 0,
        verifiedCount: 0,
        fixedCount: 0,
        retestSummary: { passed: 0, failed: 0, pending: 0 },
        findingsTruncated: false,
        generatedAt: new Date("2026-08-29"),
        webMcpAssurance: validWebMcpReceipt,
      })

      expect(html).toContain("WebMCP Tool Surface")
      expect(html).toContain("webmcp-assurance/1")
      expect(html).toContain("4096 bytes")
      expect(html).toContain("Coverage state: <strong>COMPLETE</strong>")
      expect(html).toContain("4 of 4 eligible files selected")
      expect(html).toContain("4096 admitted bytes")
      expect(html).toContain("WebMCP Findings by Control")
      expect(html).toContain("WebMCP Findings by Severity")
      expect(html).toContain("Representative remediation")
      expect(html).toContain("Constrain tool exposure.")
      expect(html).toContain("a".repeat(64))
      expect(html).not.toContain("registerTool")
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
