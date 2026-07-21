import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildEngineCommand, resolveScanBudgetUsd, type TargetInfo } from "./command-builder"

vi.mock("@lyrashield/config", () => ({
  env: {
    LYRASHIELD_ENGINE_PATH: "",
    LYRASHIELD_IMAGE: "",
    PLATFORM_MAX_SCAN_BUDGET_USD: 50,
  },
}))

const REPO_TARGET: TargetInfo = {
  id: "t1",
  type: "REPO",
  repoFullName: "org/repo",
  name: "My Repo",
}

const WEB_TARGET: TargetInfo = {
  id: "t2",
  type: "WEB_APP",
  url: "https://app.example.com",
  name: "Web App",
}

const API_TARGET: TargetInfo = {
  id: "t3",
  type: "API",
  url: "https://api.example.com",
  name: "API",
}

const IAC_TARGET: TargetInfo = {
  id: "t4",
  type: "IAC",
  url: "https://cloud.example.com/stack",
  name: "IaC Stack",
}

describe("command-builder", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("buildEngineCommand", () => {
    it("builds command for REPO target", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-1",
        goal: "VULNERABILITY_SCAN",
        mode: "SAFE",
        target: REPO_TARGET,
      })
      expect(cmd.executable).toBe("lyrashield")
      expect(cmd.args).toContain("--non-interactive")
      expect(cmd.args).toContain("--target")
      expect(cmd.args).toContain("https://github.com/org/repo")
      expect(cmd.args).toContain("--scan-mode")
      expect(cmd.args).toContain("quick")
      expect(cmd.workDir).toBe("lyrashield_runs/scan-1")
    })

    it("builds command for WEB_APP target", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-2",
        goal: "VULNERABILITY_SCAN",
        mode: "STANDARD",
        target: WEB_TARGET,
      })
      expect(cmd.args).toContain("https://app.example.com")
      expect(cmd.args).toContain("standard")
    })

    it("builds command for API target", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-3",
        goal: "VULNERABILITY_SCAN",
        mode: "DEEP",
        target: API_TARGET,
      })
      expect(cmd.args).toContain("https://api.example.com")
      expect(cmd.args).toContain("deep")
    })

    it("builds command for IAC target", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-iac",
        goal: "VULNERABILITY_SCAN",
        mode: "STANDARD",
        target: IAC_TARGET,
      })
      expect(cmd.args).toContain("https://cloud.example.com/stack")
      expect(cmd.args).toContain("standard")
    })

    it("uses repoUrl if available over repoFullName", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-4",
        goal: "VULNERABILITY_SCAN",
        mode: "SAFE",
        target: { ...REPO_TARGET, repoUrl: "https://gitlab.com/org/repo" },
      })
      expect(cmd.args).toContain("https://gitlab.com/org/repo")
    })

    it("adds instruction flag when provided", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-5",
        goal: "VULNERABILITY_SCAN",
        mode: "SAFE",
        target: WEB_TARGET,
        instruction: "Focus on XSS",
      })
      expect(cmd.args).toContain("--instruction")
      expect(cmd.args).toContain("Focus on XSS")
    })

    it("adds max-budget-usd when provided", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-6",
        goal: "VULNERABILITY_SCAN",
        mode: "SAFE",
        target: WEB_TARGET,
        maxBudgetUsd: 5.0,
      })
      expect(cmd.args).toContain("--max-budget-usd")
      expect(cmd.args).toContain("5")
    })

    it("does not add max-budget-usd when zero or negative", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-7",
        goal: "VULNERABILITY_SCAN",
        mode: "SAFE",
        target: WEB_TARGET,
        maxBudgetUsd: 0,
      })
      expect(cmd.args).not.toContain("--max-budget-usd")
    })

    it("throws for REPO target without repo info", () => {
      expect(() =>
        buildEngineCommand({
          scanId: "scan-8",
          goal: "VULNERABILITY_SCAN",
          mode: "SAFE",
          target: { id: "t", type: "REPO", name: "bad" },
        })
      ).toThrow("REPO target missing")
    })

    it("throws for WEB_APP target without url", () => {
      expect(() =>
        buildEngineCommand({
          scanId: "scan-9",
          goal: "VULNERABILITY_SCAN",
          mode: "SAFE",
          target: { id: "t", type: "WEB_APP", name: "bad" },
        })
      ).toThrow("WEB_APP target missing url")
    })

    it("throws for IAC target without url", () => {
      expect(() =>
        buildEngineCommand({
          scanId: "scan-iac-bad",
          goal: "VULNERABILITY_SCAN",
          mode: "SAFE",
          target: { id: "t", type: "IAC", name: "bad" },
        })
      ).toThrow("IAC target missing url")
    })

    it("maps QUICK mode to quick", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-quick",
        goal: "VULNERABILITY_SCAN",
        mode: "QUICK",
        target: WEB_TARGET,
      })
      expect(cmd.args).toContain("quick")
    })

    it("maps DEEP mode to deep", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-deep",
        goal: "VULNERABILITY_SCAN",
        mode: "DEEP",
        target: WEB_TARGET,
      })
      expect(cmd.args).toContain("deep")
    })

    it("defaults scan mode to deep for unknown mode", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-10",
        goal: "VULNERABILITY_SCAN",
        mode: "UNKNOWN",
        target: WEB_TARGET,
      })
      expect(cmd.args).toContain("deep")
    })
  })

  describe("resolveScanBudgetUsd", () => {
    it.each([
      ["SAFE", 1.2],
      ["QUICK", 1.2],
      ["STANDARD", 3.2],
      ["DEEP", 15],
      ["CUSTOM", 15],
      ["UNKNOWN", 15],
    ])("uses the expected default cap for %s", (mode, expectedBudget) => {
      expect(resolveScanBudgetUsd(mode)).toBe(expectedBudget)
    })

    it("uses a valid workspace policy budget over the mode default", () => {
      expect(resolveScanBudgetUsd("DEEP", 6.5)).toBe(6.5)
    })

    it("does not allow invalid policy budgets to remove the mode cap", () => {
      expect(resolveScanBudgetUsd("STANDARD", 0)).toBe(3.2)
      expect(resolveScanBudgetUsd("STANDARD", Number.NaN)).toBe(3.2)
    })

    it("clamps policy budgets to the platform maximum", () => {
      expect(resolveScanBudgetUsd("DEEP", 500)).toBe(50)
    })
  })
})
