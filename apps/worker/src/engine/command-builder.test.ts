import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildEngineCommand, resolveScanBudgetUsd, type TargetInfo } from "./command-builder"

vi.mock("@lyrashield/config", () => ({
  env: {
    LYRASHIELD_ENGINE_PATH: "",
    LYRASHIELD_ENGINE_WORK_ROOT: "/var/lib/lyrashield/worker",
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
      expect(cmd.workDir).toBe("/var/lib/lyrashield/worker/lyrashield_runs/scan-1")
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

    it("passes the OpenAPI document as a second engine target for API targets", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-api-spec",
        goal: "VULNERABILITY_SCAN",
        mode: "STANDARD",
        target: API_TARGET,
        apiSpecUrl: "https://api.example.com/openapi.json",
      })
      const targetIdx = cmd.args.indexOf("--target")
      expect(cmd.args[targetIdx + 1]).toBe("https://api.example.com")
      const secondIdx = cmd.args.indexOf("--target", targetIdx + 1)
      expect(cmd.args[secondIdx + 1]).toBe("https://api.example.com/openapi.json")
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

    it("rejects IAC targets until an IaC scan profile exists", () => {
      expect(() =>
        buildEngineCommand({
          scanId: "scan-iac",
          goal: "VULNERABILITY_SCAN",
          mode: "STANDARD",
          target: IAC_TARGET,
        })
      ).toThrow("TARGET_TYPE_UNSUPPORTED")
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

    it("passes the configured repository branch to the engine", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-branch",
        goal: "VULNERABILITY_SCAN",
        mode: "SAFE",
        target: { ...REPO_TARGET, branch: "release/2026.08" },
      })

      expect(cmd.args).toContain("--repository-branch")
      expect(cmd.args).toContain("release/2026.08")
    })

    it("adds instruction flag when provided", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-5",
        goal: "VULNERABILITY_SCAN",
        mode: "STANDARD",
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
        mode: "STANDARD",
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
        mode: "STANDARD",
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

    it("rejects QUICK on a web target — that tier is deterministic-only", () => {
      expect(() =>
        buildEngineCommand({
          scanId: "scan-quick",
          goal: "VULNERABILITY_SCAN",
          mode: "QUICK",
          target: WEB_TARGET,
        })
      ).toThrow("SCAN_MODE_UNSUPPORTED")
    })

    it("maps STANDARD mode to standard for a web target", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-std-web",
        goal: "VULNERABILITY_SCAN",
        mode: "STANDARD",
        target: WEB_TARGET,
      })
      expect(cmd.args).toContain("standard")
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

    it("pins REPO remote URLs to --target-type repository", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-kind-repo",
        goal: "VULNERABILITY_SCAN",
        mode: "SAFE",
        target: { ...REPO_TARGET, repoUrl: "https://gitlab.com/org/repo" },
      })
      const idx = cmd.args.indexOf("--target-type")
      expect(idx).toBeGreaterThan(-1)
      expect(cmd.args[idx + 1]).toBe("repository")
    })

    it("pins a checked-out REPO source tree to --target-type local_code", () => {
      const cmd = buildEngineCommand({
        scanId: "scan-kind-checkout",
        goal: "VULNERABILITY_SCAN",
        mode: "SAFE",
        target: { ...REPO_TARGET, repoUrl: "/var/lib/lyrashield/checkouts/org-repo" },
      })
      const idx = cmd.args.indexOf("--target-type")
      expect(cmd.args[idx + 1]).toBe("local_code")
    })

    it.each(["WEB_APP", "API"] as const)(
      "pins %s targets to --target-type web_application",
      (type) => {
        const cmd = buildEngineCommand({
          scanId: `scan-kind-${type}`,
          goal: "VULNERABILITY_SCAN",
          mode: "STANDARD",
          target: { ...WEB_TARGET, type },
        })
        const idx = cmd.args.indexOf("--target-type")
        expect(idx).toBeGreaterThan(-1)
        expect(cmd.args[idx + 1]).toBe("web_application")
      }
    )

    it("rejects an unknown mode instead of escalating execution", () => {
      expect(() =>
        buildEngineCommand({
          scanId: "scan-10",
          goal: "VULNERABILITY_SCAN",
          mode: "UNKNOWN",
          target: WEB_TARGET,
        })
      ).toThrow("URL_MODE_UNSUPPORTED")
    })
  })

  describe("resolveScanBudgetUsd", () => {
    it.each([
      ["SAFE", 1.2],
      ["QUICK", 1.2],
      ["STANDARD", 3.2],
      ["DEEP", 5],
      ["CUSTOM", 5],
    ])("uses the expected default cap for %s", (mode, expectedBudget) => {
      expect(resolveScanBudgetUsd(mode)).toBe(expectedBudget)
    })

    it("treats the workspace policy as a ceiling rather than an upgrade", () => {
      expect(resolveScanBudgetUsd("DEEP", 6.5)).toBe(5)
      expect(resolveScanBudgetUsd("QUICK", 6.5)).toBe(1.2)
    })

    it("treats an explicit zero budget as a deliberate stop, not a fallback", () => {
      expect(resolveScanBudgetUsd("STANDARD", 0)).toBe(0)
    })

    it("does not allow NaN/negative/undefined policy budgets to remove the mode cap", () => {
      expect(resolveScanBudgetUsd("STANDARD", Number.NaN)).toBe(3.2)
      expect(resolveScanBudgetUsd("STANDARD", -1)).toBe(3.2)
      expect(resolveScanBudgetUsd("STANDARD", undefined)).toBe(3.2)
    })

    it("rejects unknown modes before a policy can assign a spend cap", () => {
      expect(() => resolveScanBudgetUsd("UNKNOWN", 500)).toThrow("SCAN_MODE_UNSUPPORTED")
    })
  })
})
