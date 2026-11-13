import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  mkdtempSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, readSync: vi.fn(actual.readSync) }
})

import { readJsonEvidence } from "./sandbox-sbom-coverage"

const directories: string[] = []
function fixturePath() {
  const directory = mkdtempSync(join(tmpdir(), "lyrashield-evidence-file-"))
  directories.push(directory)
  return join(directory, "evidence.json")
}

afterEach(() => {
  vi.mocked(readSync).mockReset()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(typeof process.getuid !== "function")("sandbox evidence file reads", () => {
  it("reads a regular file owned by the expected identity", () => {
    const path = fixturePath()
    writeFileSync(path, '{"value":1}')
    expect(readJsonEvidence(path, "evidence", process.getuid!())).toEqual({ value: 1 })
  })

  it("rejects a wrong owner and a final-component symlink", () => {
    const path = fixturePath()
    writeFileSync(path, "{}")
    expect(() => readJsonEvidence(path, "evidence", process.getuid!() + 1)).toThrow()
    const link = `${path}.link`
    symlinkSync(path, link)
    expect(() => readJsonEvidence(link, "evidence", process.getuid!())).toThrow()
  })

  it.skipIf(process.platform === "win32")("rejects a FIFO without blocking", () => {
    const path = fixturePath()
    execFileSync("mkfifo", [path])
    expect(() => readJsonEvidence(path, "evidence", process.getuid!())).toThrow()
  })

  it("rejects oversized evidence", () => {
    const path = fixturePath()
    writeFileSync(path, "{}")
    truncateSync(path, 16 * 1024 * 1024 + 1)
    expect(() => readJsonEvidence(path, "evidence", process.getuid!())).toThrow()
  })

  it("rejects growth and replacement after opening", async () => {
    const path = fixturePath()
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs")
    writeFileSync(path, "{}")
    vi.mocked(readSync).mockImplementationOnce(((...args: Parameters<typeof readSync>) => {
      appendFileSync(path, " ")
      return realFs.readSync(...args)
    }) as typeof readSync)
    expect(() => readJsonEvidence(path, "evidence", process.getuid!())).toThrow()

    writeFileSync(path, "{}")
    vi.mocked(readSync).mockImplementationOnce(((...args: Parameters<typeof readSync>) => {
      renameSync(path, `${path}.original`)
      writeFileSync(path, '{"replacement":true}')
      return realFs.readSync(...args)
    }) as typeof readSync)
    expect(() => readJsonEvidence(path, "evidence", process.getuid!())).toThrow()
  })

  it("rejects an in-place change during the read", async () => {
    const path = fixturePath()
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs")
    writeFileSync(path, '{"value":1}')
    vi.mocked(readSync).mockImplementationOnce(((...args: Parameters<typeof readSync>) => {
      writeFileSync(path, '{"value":2}')
      utimesSync(path, new Date("2001-01-01"), new Date("2001-01-01"))
      return realFs.readSync(...args)
    }) as typeof readSync)
    expect(() => readJsonEvidence(path, "evidence", process.getuid!())).toThrow()
  })
})
