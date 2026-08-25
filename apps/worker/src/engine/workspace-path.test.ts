import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({
  env: { LYRASHIELD_ENGINE_WORK_ROOT: "/var/lib/lyrashield/worker" },
}))
vi.mock("node:os", () => ({ tmpdir: () => "/var/lib/lyrashield/worker/tmp" }))

import { ENGINE_CHECKOUT_ROOT, ENGINE_WORK_ROOT, engineWorkspacePath } from "./workspace-path"

describe("engine workspace paths", () => {
  it("keeps run and temporary checkout paths below the shared host root", () => {
    expect(ENGINE_WORK_ROOT).toBe("/var/lib/lyrashield/worker/lyrashield_runs")
    expect(ENGINE_CHECKOUT_ROOT).toBe("/var/lib/lyrashield/worker/tmp/strix_repos")
    expect(engineWorkspacePath("scan-1")).toBe("/var/lib/lyrashield/worker/lyrashield_runs/scan-1")
  })

  it.each(["", "..", "../escape", "/tmp/escape", "nested/scan"])(
    "rejects escaped scan ID %j",
    (scanId) => {
      expect(() => engineWorkspacePath(scanId)).toThrow("Invalid engine workspace scan ID")
    }
  )
})
