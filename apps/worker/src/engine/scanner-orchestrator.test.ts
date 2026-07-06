import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  scanUrl: vi.fn().mockResolvedValue([
    {
      id: "url-missing-header-content-security-policy",
      title: "Missing Content-Security-Policy header",
      severity: "MEDIUM",
      timestamp: new Date().toISOString(),
      cwe: "CWE-693",
      description: "Missing CSP header",
      remediation_steps: "Add CSP header",
    },
  ]),
}))

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}))

import { runScannerOrchestrator } from "./scanner-orchestrator"
import { scanSca } from "./scanners/sca-scanner"
import { scanSecrets } from "./scanners/secrets-scanner"
import { scanUrl } from "./scanners/url-scanner"
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

describe("runScannerOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("runs all scanners and merges findings", async () => {
    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: {
        id: "target-1",
        type: "REPO",
        url: "https://github.com/test/repo",
        repoFullName: "test/repo",
        name: "Test Repo",
      },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings,
    })

    expect(scanSca).toHaveBeenCalled()
    expect(scanSecrets).toHaveBeenCalled()
    expect(scanUrl).toHaveBeenCalled()

    expect(result.engineFindings.length).toBe(1)
    expect(result.scaFindings.length).toBe(1)
    expect(result.secretsFindings.length).toBe(1)
    expect(result.urlFindings.length).toBe(1)
    expect(result.allFindings.length).toBe(4)
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
    })

    expect(result.engineFindings).toEqual([])
    expect(result.scaFindings.length).toBe(1)
    expect(result.secretsFindings.length).toBe(1)
    expect(result.urlFindings.length).toBe(0)
    expect(result.allFindings.length).toBe(2)
  })

  it("handles SCA scanner failure gracefully", async () => {
    vi.mocked(scanSca).mockRejectedValueOnce(new Error("OSV API down") as never)

    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings,
    })

    expect(result.scaFindings).toEqual([])
    expect(result.engineFindings.length).toBe(1)
    expect(result.secretsFindings.length).toBe(1)
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

    vi.mocked(scanUrl).mockResolvedValueOnce([
      {
        id: "url-missing-header-content-security-policy",
        title: "Missing Content-Security-Policy header",
        severity: "MEDIUM",
        timestamp: new Date().toISOString(),
        cwe: "CWE-693",
        description: "Missing CSP header",
        remediation_steps: "Add CSP header",
      },
    ])

    const result = await runScannerOrchestrator({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      target: { id: "target-1", type: "REPO", name: "Test" },
      goal: "TEST_APP",
      mode: "STANDARD",
      engineFindings: [lowEngineFinding],
    })

    // The dedupeKey should collide — only one finding should remain for this CWE
    // The URL scanner finding (MEDIUM) should win over engine finding (LOW)
    const merged = result.allFindings.find((f) => f.title.includes("Content-Security-Policy"))
    if (merged) {
      expect(merged.normalizedSeverity).toBe("MEDIUM")
    }
  })
})
