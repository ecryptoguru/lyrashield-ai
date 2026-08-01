/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

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
  cwd = await mkdtemp(path.join(tmpdir(), "lyrashield-atomic-"))
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
