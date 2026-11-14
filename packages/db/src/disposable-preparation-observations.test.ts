import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  inspectDisposablePreparationImage,
  readDisposableSourceReceipt,
} from "./disposable-preparation-observations"
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}))
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
async function source() {
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  vi.mocked(execFileSync).mockImplementation(original.execFileSync)
  const root = mkdtempSync(join(tmpdir(), "lyra-disposable-source-"))
  dirs.push(root)
  chmodSync(root, 0o700)
  execFileSync("git", ["init", "-q", root])
  writeFileSync(join(root, "fixture.txt"), "immutable source\n", { mode: 0o600 })
  execFileSync("git", ["-C", root, "add", "fixture.txt"])
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Disposable fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-qm",
    "fixture",
  ])
  const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim()
  return { root, revision }
}
describe("actual staged input observations", () => {
  it("hashes a clean exact Git tree and rejects a changed revision or dirty bytes", async () => {
    const f = await source()
    const first = readDisposableSourceReceipt(f.root, f.revision)
    expect(first.entries).toHaveLength(1)
    expect(readDisposableSourceReceipt(f.root, f.revision)).toEqual(first)
    expect(() => readDisposableSourceReceipt(f.root, "f".repeat(40))).toThrow()
    writeFileSync(join(f.root, "fixture.txt"), "changed\n")
    expect(() => readDisposableSourceReceipt(f.root, f.revision)).toThrow()
  })
  it("rejects symlinked Git source leaves and writable staged roots", async () => {
    const f = await source()
    chmodSync(f.root, 0o777)
    expect(() => readDisposableSourceReceipt(f.root, f.revision)).toThrow()
    chmodSync(f.root, 0o700)
    rmSync(join(f.root, "fixture.txt"))
    symlinkSync("/etc/hosts", join(f.root, "fixture.txt"))
    expect(() => readDisposableSourceReceipt(f.root, f.revision)).toThrow()
  })
  it.each(["ignored.sh", "generated/ignored.sh"])(
    "rejects ignored executable input %s even when normal Git status is clean",
    async (path) => {
      const f = await source()
      writeFileSync(join(f.root, ".git/info/exclude"), "*.sh\n", { mode: 0o600 })
      expect(readDisposableSourceReceipt(f.root, f.revision).entries).toHaveLength(1)
      mkdirSync(join(f.root, "generated"), { recursive: true, mode: 0o700 })
      writeFileSync(join(f.root, path), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
      expect(
        execFileSync("git", ["-C", f.root, "status", "--porcelain", "--untracked-files=all"])
          .toString()
          .trim()
      ).toBe("")
      expect(() => readDisposableSourceReceipt(f.root, f.revision)).toThrow()
    }
  )
  it("requires exact native image digest, entrypoint and OCI source revision", () => {
    const digest = "sha256:" + "a".repeat(64),
      revision = "b".repeat(40),
      source = "https://github.com/ecryptoguru/lyrashield-ai"
    const image = {
      Id: digest,
      Os: "linux",
      RepoDigests: ["registry/engine@" + digest],
      Config: {
        Entrypoint: [],
        Labels: {
          "org.opencontainers.image.revision": revision,
          "org.opencontainers.image.source": source,
        },
      },
    }
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(JSON.stringify([image])))
    expect(
      inspectDisposablePreparationImage("registry/engine@" + digest, [], revision, source).configId
    ).toBe(digest)
    expect(() =>
      inspectDisposablePreparationImage(
        "registry/engine@" + digest,
        ["docker-entrypoint.sh"],
        revision,
        source
      )
    ).toThrow()
    expect(() =>
      inspectDisposablePreparationImage("registry/engine@" + digest, [], "c".repeat(40), source)
    ).toThrow()
    expect(() =>
      inspectDisposablePreparationImage(
        "registry/engine@sha256:" + "d".repeat(64),
        [],
        revision,
        source
      )
    ).toThrow()
  })
})
