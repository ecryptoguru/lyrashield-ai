/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, readFile } from "node:fs/promises"
import { tmpdir as osTmpdir } from "node:os"
import path from "node:path"

// Resolve the OS temp dir up front: on macOS it is itself a symlink
// (/var -> /private/var), which would otherwise trip the ancestor-chain guard
// these tests exercise and make every case fail for the wrong reason.
const tmpdir = async () => realpath(osTmpdir())

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(),
}))

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  return {
    ...actual,
    lstat: vi.fn(),
  }
})

import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import { atomicWrite } from "../../installers/atomic-write.js"

const mockedRandomUUID = vi.mocked(randomUUID)
const mockedLstat = vi.mocked(lstat)

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(path.join(await tmpdir(), "lyrashield-atomic-"))
  mockedLstat.mockImplementation(async (p) => {
    // Pass through to the real lstat so tests that rely on file type still work.
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    return actual.lstat(p as string)
  })
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe("atomicWrite", () => {
  it("writes a file atomically and the final path is a regular file", async () => {
    const target = path.join(cwd, "config.json")
    mockedRandomUUID.mockReturnValue("00000000-0000-0000-0000-000000000001")

    await atomicWrite(target, "hello")

    const content = await readFile(target, "utf-8")
    expect(content).toBe("hello")
    expect(mockedLstat).toHaveBeenCalledWith(target)
  })

  it.runIf(process.platform === "darwin" && osTmpdir().startsWith("/var/"))(
    "allows the macOS /var system alias",
    async () => {
      const rawTempDir = await mkdtemp(path.join(osTmpdir(), "lyrashield-atomic-var-"))
      const target = path.join(rawTempDir, "config.json")
      mockedRandomUUID.mockReturnValue("00000000-0000-0000-0000-000000000008")

      try {
        await atomicWrite(target, "hello")
        expect(await readFile(target, "utf-8")).toBe("hello")
      } finally {
        await rm(rawTempDir, { recursive: true, force: true })
      }
    }
  )

  it("overwrites an existing regular file with new content", async () => {
    const target = path.join(cwd, "config.json")
    await writeFile(target, "old", "utf-8")
    mockedRandomUUID.mockReturnValue("00000000-0000-0000-0000-000000000002")

    await atomicWrite(target, "new")

    expect(await readFile(target, "utf-8")).toBe("new")
  })

  it("fails when an attacker pre-created the temp path as a file", async () => {
    const target = path.join(cwd, "config.json")
    const fixedUuid = "00000000-0000-0000-0000-000000000003"
    const expectedTmp = `${target}.${fixedUuid}.lyrashield-tmp`
    mockedRandomUUID.mockReturnValue(fixedUuid)
    await writeFile(expectedTmp, "pre-existing", "utf-8")

    await expect(atomicWrite(target, "hello")).rejects.toThrow(/EEXIST/)
  })

  it("fails when an attacker pre-created the temp path as a symlink", async () => {
    const target = path.join(cwd, "config.json")
    const other = path.join(cwd, "other.json")
    const fixedUuid = "00000000-0000-0000-0000-000000000004"
    const expectedTmp = `${target}.${fixedUuid}.lyrashield-tmp`
    mockedRandomUUID.mockReturnValue(fixedUuid)
    await writeFile(other, "victim", "utf-8")
    await import("node:fs/promises").then(({ symlink }) => symlink(other, expectedTmp))

    await expect(atomicWrite(target, "hello")).rejects.toThrow()
  })

  it("rejects when the destination directory itself is a symlink", async () => {
    const realDir = await mkdtemp(path.join(await tmpdir(), "lyrashield-atomic-real-"))
    const linkDir = path.join(await tmpdir(), "lyrashield-atomic-link-")
    await symlink(realDir, linkDir)

    try {
      const target = path.join(linkDir, "config.json")
      await expect(atomicWrite(target, "hello")).rejects.toThrow(
        /Refusing to write through a symlinked directory/
      )
    } finally {
      await rm(linkDir, { force: true })
      await rm(realDir, { recursive: true, force: true })
    }
  })

  // Regression guard. An lstat-only check on the immediate parent passes this
  // case, because the parent (`rules`) is a real directory — the symlink is its
  // parent. That is the exact shape of every installer target we write
  // (`.cursor/rules/lyrashield.mdc`, `~/.codeium/windsurf/mcp_config.json`), so
  // a grandparent redirect must be rejected, not just an immediate-parent one.
  it("rejects when a GRANDPARENT directory is a symlink", async () => {
    const realBase = await mkdtemp(path.join(await tmpdir(), "lyrashield-atomic-gp-real-"))
    const linkBase = path.join(await tmpdir(), `lyrashield-atomic-gp-link-${Date.now()}`)
    await mkdir(path.join(realBase, "rules"), { recursive: true })
    await symlink(realBase, linkBase)

    try {
      // linkBase is the symlink; `rules` under it is a genuine directory.
      const target = path.join(linkBase, "rules", "lyrashield.mdc")
      await expect(atomicWrite(target, "hello")).rejects.toThrow(
        /Refusing to write through a symlinked directory/
      )
    } finally {
      await rm(linkBase, { force: true })
      await rm(realBase, { recursive: true, force: true })
    }
  })

  it("still writes normally when the whole ancestor chain is real", async () => {
    const nested = path.join(cwd, "deep", "nested", "path")
    await mkdir(nested, { recursive: true })
    const target = path.join(nested, "config.json")
    mockedRandomUUID.mockReturnValue("00000000-0000-0000-0000-000000000006")

    await atomicWrite(target, "hello")

    expect(await readFile(target, "utf-8")).toBe("hello")
  })

  it("allows a destination whose directory does not exist yet", async () => {
    // Callers mkdir -p after this check; a path component that does not exist
    // cannot be hiding a symlink, so this must not throw.
    const target = path.join(cwd, "not", "created", "yet.json")
    mockedRandomUUID.mockReturnValue("00000000-0000-0000-0000-000000000007")

    // The write itself fails (no directory), but NOT with the symlink refusal.
    await expect(atomicWrite(target, "hello")).rejects.not.toThrow(
      /Refusing to write through a symlinked directory/
    )
  })

  it("rejects the final path when it is not a regular file after rename", async () => {
    const target = path.join(cwd, "config.json")
    mockedRandomUUID.mockReturnValue("00000000-0000-0000-0000-000000000005")

    mockedLstat.mockImplementation(async (p) => {
      if (p === target) {
        return { isFile: () => false } as unknown as ReturnType<typeof lstat>
      }
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      return actual.lstat(p as string)
    })

    await expect(atomicWrite(target, "hello")).rejects.toThrow(
      /Atomic write did not produce a regular file/
    )
  })
})
