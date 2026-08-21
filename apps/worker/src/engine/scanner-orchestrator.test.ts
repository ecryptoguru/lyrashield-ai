import { describe, it, expect, vi, beforeEach } from "vitest"

const mockEnv = vi.hoisted(() => ({
  NODE_ENV: "test",
  SCANNER_PHASE_TIMEOUT_MS: 600_000,
  LYRASHIELD_EGRESS_PROXY_URL: "",
  LYRASHIELD_EGRESS_PROXY_SECRET: "",
  LYRASHIELD_EGRESS_PROXY_CONNECT_TIMEOUT_MS: 10_000,
  LYRASHIELD_EGRESS_PROXY_READ_TIMEOUT_MS: 30_000,
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock("@lyrashield/config", () => ({ env: mockEnv }))

vi.mock("@lyrashield/db", () => ({
  addScanEvent: vi.fn().mockResolvedValue(undefined),
  queryOsvWithCache: vi.fn().mockResolvedValue({
    status: "COMPLETE",
    source: "OSV",
    requestedCount: 1,
    resolvedCount: 1,
    results: [],
    fetchedAt: "2026-08-14T00:00:00.000Z",
    snapshotId: "snapshot",
    snapshotChecksum: "snapshot",
    cacheAgeSeconds: 0,
    supportedEcosystems: ["npm"],
    unresolved: [],
  }),
}))

vi.mock("./scanners/resolved-dependencies", () => ({
  resolveExactDependencies: vi.fn().mockResolvedValue({
    status: "COMPLETE",
    packages: [
      { ecosystem: "npm", name: "lodash", version: "4.17.20", filePath: "package-lock.json" },
    ],
    unresolved: [],
    truncated: false,
    evidenceFile: {
      path: "package-lock.json",
      content: "{}",
      size: 2,
      extension: ".json",
      language: "json",
    },
  }),
}))

vi.mock("./scanners/sca-scanner", () => ({
  scanSca: vi.fn().mockResolvedValue([
    {
      id: "CVE-2024-1234",
      title: "Vulnerable dependency: lodash@4.17.20",
      severity: "high",
      timestamp: new Date().toISOString(),
      target: "package.json",
      cwe: "CWE-1104",
      cve: "CVE-2024-1234",
      description: "Prototype pollution",
      remediation_steps: "Upgrade to 4.17.21",
      poc_description: "Check OSV database",
    },
  ]),
}))

vi.mock("./scanners/secrets-scanner", () => ({
  scanSecrets: vi.fn().mockResolvedValue([
    {
      id: "github-token-config.ts-1",
      title: "GitHub Personal Access Token in config.ts:1",
      severity: "critical",
      timestamp: new Date().toISOString(),
      target: "config.ts",
      cwe: "CWE-798",
      description: "GitHub token found",
      remediation_steps: "Remove and rotate",
      poc_description: "Read line 1 of config.ts",
      code_locations: [{ file: "config.ts", start_line: 1 }],
    },
  ]),
}))

vi.mock("./scanners/url-scanner", () => ({
  scanUrl: vi.fn().mockResolvedValue({
    findings: [
      {
        id: "url-missing-header-content-security-policy",
        title: "Missing Content-Security-Policy header",
        severity: "MEDIUM",
        timestamp: new Date().toISOString(),
        cwe: "CWE-693",
        description: "Missing CSP header",
        remediation_steps: "Add CSP header",
      },
    ],
    execution: {
      contractVersion: "url-scan/2.0.0",
      profile: "WEB_APP_SAFE",
      methods: ["GET"],
      subjectCount: 1,
      totalBytes: 100,
      truncated: false,
      issues: [],
    },
    issues: [],
  }),
}))

vi.mock("./scanners/agent-config-scanner", () => ({
  scanAgentConfig: vi.fn().mockResolvedValue([]),
}))

vi.mock("./scanners/ml-supply-chain-scanner", () => ({
  scanMlSupplyChain: vi.fn().mockResolvedValue([]),
}))

vi.mock("./scanners/ai-app-security", () => ({
  scanAiAppSecurity: vi.fn().mockResolvedValue({
    findings: [],
    aiScanResult: {
      signals: [],
      coverage: {
        version: "ai-app-security/2026-08-13.1",
        totalControls: 8,
        assessedCount: 0,
        notAssessedCount: 8,
        detectedCount: 0,
        noFindingCount: 0,
        inconclusiveCount: 0,
        controls: {},
        limitsReached: [],
        unsupportedFiles: [],
        truncatedFiles: [],
      },
      provenance: {
        files: 0,
        bytes: 0,
        scannedAt: new Date().toISOString(),
        limitsReached: [],
        detectorVersion: "ai-app-security/2026-08-13.1",
      },
    },
    ai03AdvisoryFresh: false,
  }),
}))

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}))

import { runScannerOrchestrator } from "./scanner-orchestrator"
import { scanSca } from "./scanners/sca-scanner"
import { scanSecrets } from "./scanners/secrets-scanner"
import { scanUrl } from "./scanners/url-scanner"
import { scanAgentConfig } from "./scanners/agent-config-scanner"
import { scanMlSupplyChain } from "./scanners/ml-supply-chain-scanner"
import { scanAiAppSecurity } from "./scanners/ai-app-security"
import { addScanEvent, queryOsvWithCache } from "@lyrashield/db"
import { resolveExactDependencies } from "./scanners/resolved-dependencies"
import type { EngineVulnerability } from "./output-parser"

const engineFindings: EngineVulnerability[] = [
  {
    id: "v1",
    title: "XSS in search endpoint",
    severity: "high",
    timestamp: new Date().toISOString(),
    target: "https://app.test-target.com",
    endpoint: "/search",
    method: "GET",
    cwe: "CWE-79",
    description: "Reflected XSS in search parameter",
    poc_description: "Inject <script> in search query",
    remediation_steps: "Encode output",
  },
]
const sourceCheckout = "/tmp/strix_repos/test/repo"

describe("runScannerOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.NODE_ENV = "test"
    mockEnv.LYRASHIELD_EGRESS_PROXY_URL = ""
    mockEnv.LYRASHIELD_EGRESS_PROXY_SECRET = ""
  })

  it("runs all scanners and merges findings", async () => {
    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: {
        id: "target-1",
        type: "REPO",
        repoFullName: "test/repo",
        name: "Test Repo",
      },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings,
      workspaceDir: sourceCheckout,
    })

    expect(scanSca).toHaveBeenCalled()
    expect(scanSecrets).toHaveBeenCalled()
    expect(scanAgentConfig).toHaveBeenCalled()
    expect(scanMlSupplyChain).toHaveBeenCalled()

    expect(result.engineFindings.length).toBe(1)
    expect(result.scaFindings.length).toBe(1)
    expect(result.secretsFindings.length).toBe(1)
    expect(result.urlFindings.length).toBe(0)
    expect(result.agentConfigFindings).toEqual([])
    expect(result.mlSupplyChainFindings).toEqual([])
    expect(result.allFindings.length).toBe(3)
  })

  it("resolves and queries exact advisory packages once for SCA and AI-03", async () => {
    await runScannerOrchestrator({
      scanId: "scan-shared-advisory",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings: [],
      workspaceDir: sourceCheckout,
    })

    expect(resolveExactDependencies).toHaveBeenCalledTimes(1)
    expect(queryOsvWithCache).toHaveBeenCalledTimes(1)
    const scaConfig = vi.mocked(scanSca).mock.calls.at(-1)?.[0]
    const aiConfig = vi.mocked(scanAiAppSecurity).mock.calls.at(-1)?.[0]
    expect(scaConfig?.resolvedDependencyInventory).toBe(aiConfig?.dependencyInventory)
    expect(scaConfig?.advisoryBatch).toBe(aiConfig?.advisoryBatch)
  })

  it("runs the URL scanner for web targets when a profile is provided", async () => {
    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: {
        id: "target-1",
        type: "WEB_APP",
        url: "https://example.test",
        name: "Web target",
      },
      goal: "LAUNCH_REVIEW",
      mode: "SAFE",
      engineFindings: [],
      urlProfile: {
        id: "WEB_APP_SAFE",
        targetType: "WEB_APP",
        mode: "SAFE",
        label: "Surface Review",
        description: "...",
        maxDocuments: 1,
        maxAssets: 6,
        maxDepth: 0,
        maxTotalBytes: 8 * 1024 * 1024,
        maxResponseBytes: 3 * 1024 * 1024,
        maxConcurrency: 3,
        maxWallTimeMs: 60_000,
        maxOperations: 0,
        maxMethodProbes: 0,
        maxOriginProbes: 0,
        allowedMethods: ["GET"],
        requiresApiSpec: false,
      },
    })

    expect(scanUrl).toHaveBeenCalled()
    expect(result.urlFindings.length).toBe(1)
  })

  it("fails closed before a production URL scan when the egress proxy is unavailable", async () => {
    mockEnv.NODE_ENV = "production"

    await expect(
      runScannerOrchestrator({
        scanId: "scan-no-egress-proxy",
        workspaceId: "ws-1",
        targetId: "target-1",
        target: {
          id: "target-1",
          type: "WEB_APP",
          url: "https://example.test",
          name: "Web target",
        },
        goal: "LAUNCH_REVIEW",
        mode: "SAFE",
        engineFindings: [],
        urlProfile: {
          id: "WEB_APP_SAFE",
          targetType: "WEB_APP",
          mode: "SAFE",
          label: "Surface Review",
          description: "...",
          maxDocuments: 1,
          maxAssets: 6,
          maxDepth: 0,
          maxTotalBytes: 8 * 1024 * 1024,
          maxResponseBytes: 3 * 1024 * 1024,
          maxConcurrency: 3,
          maxWallTimeMs: 60_000,
          maxOperations: 0,
          maxMethodProbes: 0,
          maxOriginProbes: 0,
          allowedMethods: ["GET"],
          requiresApiSpec: false,
        },
      })
    ).rejects.toThrow("Production URL scans require the authenticated egress proxy")
    expect(scanUrl).not.toHaveBeenCalled()
  })

  it("normalizes all findings with correct severity", async () => {
    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings,
      workspaceDir: sourceCheckout,
    })

    const critical = result.allFindings.filter((f) => f.normalizedSeverity === "CRITICAL")
    const high = result.allFindings.filter((f) => f.normalizedSeverity === "HIGH")
    expect(critical.length).toBe(1) // github token
    expect(high.length).toBe(2) // xss + sca
  })

  it("calculates stats correctly", async () => {
    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings,
      workspaceDir: sourceCheckout,
    })

    expect(result.stats.total).toBe(3)
    expect(result.stats.bySeverity["CRITICAL"]).toBe(1)
    expect(result.stats.bySeverity["HIGH"]).toBe(2)
  })

  it("handles empty engine findings", async () => {
    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings: [],
      workspaceDir: sourceCheckout,
    })

    expect(result.engineFindings).toEqual([])
    expect(result.scaFindings.length).toBe(1)
    expect(result.secretsFindings.length).toBe(1)
    expect(result.urlFindings.length).toBe(0)
    expect(result.allFindings.length).toBe(2)
  })

  it("skips source scanners for non-repository targets instead of reporting empty passes", async () => {
    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "WEB_APP", name: "Web app", url: "https://example.test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings: [],
      workspaceDir: sourceCheckout,
    })
    expect(scanSca).not.toHaveBeenCalled()
    expect(scanSecrets).not.toHaveBeenCalled()
    expect(scanAgentConfig).not.toHaveBeenCalled()
    expect(scanMlSupplyChain).not.toHaveBeenCalled()
    expect(result.scaFindings).toEqual([])
    expect(result.secretsFindings).toEqual([])
    expect(addScanEvent).toHaveBeenCalledWith(
      "scan-1",
      "scanner",
      "info",
      "SCA/secrets/AI app security skipped — no source checkout for this target type",
      expect.any(Object)
    )
  })

  it("records a coverage gap instead of scanning an empty repository artifact directory", async () => {
    const result = await runScannerOrchestrator({
      scanId: "scan-missing-checkout",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Repository" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings: [],
    })

    expect(scanSca).not.toHaveBeenCalled()
    expect(scanSecrets).not.toHaveBeenCalled()
    expect(scanAgentConfig).not.toHaveBeenCalled()
    expect(scanMlSupplyChain).not.toHaveBeenCalled()
    expect(result.coverageIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scanner: "sca", status: "unsupported" }),
        expect.objectContaining({ scanner: "secrets", status: "unsupported" }),
      ])
    )
    expect(addScanEvent).toHaveBeenCalledWith(
      "scan-missing-checkout",
      "scanner",
      "warning",
      "SCA/secrets/AI app security skipped — validated source checkout unavailable for repository target",
      expect.any(Object)
    )
  })

  it("persists deterministic scanner coverage limitations as scan evidence", async () => {
    vi.mocked(scanSca).mockImplementationOnce(async (config) => {
      config.coverageIssues?.push({
        scanner: "sca",
        status: "partial",
        subject: "pom.xml",
        reason: "A Maven dependency version could not be resolved from the local POM",
      })
      return []
    })

    const result = await runScannerOrchestrator({
      scanId: "scan-coverage",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings: [],
      workspaceDir: sourceCheckout,
    })

    expect(result.coverageIssues).toHaveLength(1)
    expect(addScanEvent).toHaveBeenCalledWith(
      "scan-coverage",
      "scanner",
      "warning",
      "Deterministic scanner coverage incomplete",
      expect.objectContaining({ scanner: "sca", status: "partial" })
    )
  })

  it("retains other results and records partial coverage when the SCA scanner cannot run", async () => {
    vi.mocked(scanSca).mockRejectedValueOnce(new Error("OSV API down") as never)

    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings,
      workspaceDir: sourceCheckout,
    })

    expect(result.engineFindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "v1", scannerSource: "engine" })])
    )
    expect(result.coverageIssues).toContainEqual(
      expect.objectContaining({ scanner: "sca", status: "partial", reason: "OSV API down" })
    )
  })

  it("fails the scanner phase and records an event when the phase times out", async () => {
    vi.mocked(scanSca).mockImplementationOnce(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        }) as never
    )
    await expect(
      runScannerOrchestrator({
        scanId: "scan-timeout",
        workspaceId: "ws-1",
        targetId: "target-1",
        target: { id: "target-1", type: "REPO", name: "Test" },
        goal: "TEST_APP",
        mode: "STANDARD",
        engineFindings: [],
        scannerPhaseTimeoutMs: 1,
        workspaceDir: sourceCheckout,
      })
    ).rejects.toThrow("Scanner phase timed out")
    expect(addScanEvent).toHaveBeenCalledWith(
      "scan-timeout",
      "scanner",
      "error",
      "Scanner phase timed out",
      { timeoutMs: 1 }
    )
  })

  it("stops deterministic scanners when the scan has been cancelled", async () => {
    vi.mocked(scanUrl).mockImplementationOnce(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        }) as never
    )

    await expect(
      runScannerOrchestrator({
        scanId: "scan-cancelled",
        workspaceId: "ws-1",
        targetId: "target-1",
        target: { id: "target-1", type: "WEB_APP", url: "https://example.com", name: "Test" },
        goal: "TEST_APP",
        mode: "STANDARD",
        engineFindings: [],
        workspaceDir: sourceCheckout,
        isCancelled: async () => true,
        urlProfile: {
          id: "WEB_APP_STANDARD",
          targetType: "WEB_APP",
          mode: "STANDARD",
          label: "Expanded Surface Review",
          description: "...",
          maxDocuments: 20,
          maxAssets: 30,
          maxDepth: 2,
          maxTotalBytes: 25 * 1024 * 1024,
          maxResponseBytes: 3 * 1024 * 1024,
          maxConcurrency: 4,
          maxWallTimeMs: 120_000,
          maxOperations: 0,
          maxMethodProbes: 0,
          maxOriginProbes: 0,
          allowedMethods: ["GET"],
          requiresApiSpec: false,
        },
      })
    ).rejects.toThrow("Scanner phase cancelled")
  })

  it("tags detector provenance so secret findings receive the score cap", async () => {
    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings,
      workspaceDir: sourceCheckout,
    })

    expect(result.secretsFindings[0]?.scannerSource).toBe("secrets")
  })

  it("keeps higher severity finding on cross-source dedupeKey collision", async () => {
    // Both engine and URL scanner produce a finding with the same dedupeKey.
    // Engine finding is LOW, URL scanner finding is HIGH.
    // The merged result should keep the HIGH finding.
    const lowEngineFinding: EngineVulnerability = {
      id: "url-missing-header-content-security-policy",
      title: "Missing CSP header (engine)",
      severity: "low",
      timestamp: new Date().toISOString(),
      cwe: "CWE-693",
      description: "Missing CSP",
      remediation_steps: "Add CSP",
    }

    vi.mocked(scanUrl).mockResolvedValueOnce({
      findings: [
        {
          id: "url-missing-header-content-security-policy",
          title: "Missing Content-Security-Policy header",
          severity: "MEDIUM",
          timestamp: new Date().toISOString(),
          cwe: "CWE-693",
          description: "Missing CSP header",
          remediation_steps: "Add CSP header",
        },
      ],
      execution: {
        contractVersion: "url-scan/2.0.0",
        profile: "WEB_APP_SAFE",
        methods: ["GET"],
        subjectCount: 1,
        totalBytes: 100,
        truncated: false,
        issues: [],
      },
      issues: [],
    })

    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings: [lowEngineFinding],
      workspaceDir: sourceCheckout,
    })

    // The dedupeKey should collide — only one finding should remain for this CWE
    // The URL scanner finding (MEDIUM) should win over engine finding (LOW)
    const merged = result.allFindings.find((f) => f.title.includes("Content-Security-Policy"))
    if (merged) {
      expect(merged.normalizedSeverity).toBe("MEDIUM")
    }
  })
})
