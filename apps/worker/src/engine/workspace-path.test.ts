import { beforeEach, describe, expect, it, vi } from "vitest"

const filesystem = vi.hoisted(() => ({
  access: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
}))

vi.mock("@lyrashield/config", () => ({
  env: { LYRASHIELD_ENGINE_WORK_ROOT: "/var/lib/lyrashield/worker" },
}))
vi.mock("node:os", () => ({ tmpdir: () => "/var/lib/lyrashield/worker/tmp" }))
vi.mock("node:fs/promises", () => filesystem)

import {
  ENGINE_CHECKOUT_ROOT,
  ENGINE_TEMP_ROOT,
  ENGINE_WORK_ROOT,
  assertEngineTempRootReady,
  engineWorkspacePath,
} from "./workspace-path"

describe("engine workspace paths", () => {
  beforeEach(() => {
    filesystem.access.mockResolvedValue(undefined)
    filesystem.realpath.mockResolvedValue("/var/lib/lyrashield/worker/tmp")
    filesystem.lstat.mockResolvedValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
    })
  })

  it("keeps run and temporary checkout paths below the shared host root", () => {
    expect(ENGINE_WORK_ROOT).toBe("/var/lib/lyrashield/worker/lyrashield_runs")
    expect(ENGINE_TEMP_ROOT).toBe("/var/lib/lyrashield/worker/tmp")
    expect(ENGINE_CHECKOUT_ROOT).toBe("/var/lib/lyrashield/worker/tmp/strix_repos")
    expect(engineWorkspacePath("scan-1")).toBe("/var/lib/lyrashield/worker/lyrashield_runs/scan-1")
  })

  it.each(["", "..", "../escape", "/tmp/escape", "nested/scan"])(
    "rejects escaped scan ID %j",
    (scanId) => {
      expect(() => engineWorkspacePath(scanId)).toThrow("Invalid engine workspace scan ID")
    }
  )

  it("accepts a writable, non-symlinked temp root", async () => {
    await expect(assertEngineTempRootReady()).resolves.toBeUndefined()
    expect(filesystem.access).toHaveBeenCalledWith(
      "/var/lib/lyrashield/worker/tmp",
      expect.any(Number)
    )
  })

  it("accepts a trusted macOS parent-path alias", async () => {
    filesystem.realpath.mockResolvedValue("/unexpected/shared/tmp")

    await expect(assertEngineTempRootReady()).resolves.toBeUndefined()
  })

  it("fails closed when the configured temp root itself is a symlink", async () => {
    filesystem.lstat.mockResolvedValue({
      isDirectory: () => true,
      isSymbolicLink: () => true,
    })

    await expect(assertEngineTempRootReady()).rejects.toThrow("real directory")
  })
})
