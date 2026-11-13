import {
  link,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { inspectSupervisorIndependentComposition } from "./independent-composition"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "supervisor-composition-")))
  roots.push(root)
  const options = {
    admission: "closed",
    epochId: "epoch-1",
    supervisorInstanceId: "supervisor-1",
    originalPath: join(root, "original.jsonl"),
    independentPath: join(root, "independent.jsonl"),
    originalSigningSecret: "o".repeat(48),
    independentSigningSecret: "i".repeat(48),
  }
  await writeFile(options.originalPath, "original retained bytes\n")
  return { root, options }
}

describe("closed supervisor independent-journal composition inspection", () => {
  it("validates distinct files without writing or claiming authority or credential isolation", async () => {
    const f = await fixture()
    const before = await readFile(f.options.originalPath)
    const files = await readdir(f.root)
    expect(await inspectSupervisorIndependentComposition(f.options)).toMatchObject({
      admission: "closed",
      productionEligible: false,
      originalPath: f.options.originalPath,
      independentPath: f.options.independentPath,
      reason: expect.stringContaining("full-command"),
    })
    expect(await readFile(f.options.originalPath)).toEqual(before)
    expect(await readdir(f.root)).toEqual(files)
  })

  it.each(["normalized", "symlink", "parent-alias", "hardlink"])(
    "rejects %s file aliases without changing bytes",
    async (alias) => {
      const f = await fixture()
      if (alias === "normalized") f.options.independentPath = `${f.root}/./original.jsonl`
      if (alias === "symlink") await symlink(f.options.originalPath, f.options.independentPath)
      if (alias === "hardlink") await link(f.options.originalPath, f.options.independentPath)
      if (alias === "parent-alias") {
        await symlink(f.root, join(f.root, "alias"))
        f.options.independentPath = join(f.root, "alias", "original.jsonl")
      }
      const before = await readFile(f.options.originalPath),
        files = await readdir(f.root)
      await expect(inspectSupervisorIndependentComposition(f.options)).rejects.toThrow(
        /alias|symbolic/
      )
      expect(await readFile(f.options.originalPath)).toEqual(before)
      expect(await readdir(f.root)).toEqual(files)
    }
  )

  it.each([
    "segment",
    "segment-reversed",
    "segment-stem",
    "segment-stem-reversed",
    "lock",
    "case-variant-segment",
    "case-variant-lock",
    "unicode-variant-segment",
    "parent-alias-segment",
  ])("rejects %s overlapping namespaces without writing", async (kind) => {
    const f = await fixture()
    if (kind === "segment") f.options.independentPath = `${f.options.originalPath}.segment.2`
    if (kind === "segment-reversed") {
      f.options.independentPath = f.options.originalPath
      f.options.originalPath = `${f.options.originalPath}.segment.2`
    }
    if (kind === "segment-stem") f.options.independentPath = `${f.options.originalPath}.segment`
    if (kind === "segment-stem-reversed") {
      f.options.independentPath = f.options.originalPath
      f.options.originalPath = `${f.options.originalPath}.segment`
    }
    if (kind === "lock") f.options.independentPath = `${f.options.originalPath}.lock`
    if (kind === "case-variant-segment")
      f.options.independentPath = join(f.root, "ORIGINAL.JSONL.SEGMENT.2")
    if (kind === "case-variant-lock")
      f.options.independentPath = join(f.root, "ORIGINAL.JSONL.LOCK")
    if (kind === "unicode-variant-segment") {
      f.options.originalPath = join(f.root, "café")
      f.options.independentPath = join(f.root, "cafe\u0301.segment.2")
    }
    if (kind === "parent-alias-segment") {
      await symlink(f.root, join(f.root, "alias"))
      f.options.independentPath = join(f.root, "alias", "original.jsonl.segment.2")
    }
    const files = await readdir(f.root)
    await expect(inspectSupervisorIndependentComposition(f.options)).rejects.toThrow(
      /alias|namespace/
    )
    expect(await readdir(f.root)).toEqual(files)
  })

  it.each(["equal-keys", "invalid-epoch", "oversized-supervisor", "open", "invented-authority"])(
    "rejects %s before creating the independent file",
    async (failure) => {
      const f = await fixture()
      const options: Record<string, unknown> = { ...f.options }
      if (failure === "equal-keys")
        options.independentSigningSecret = f.options.originalSigningSecret
      if (failure === "invalid-epoch") options.epochId = "epoch/bad"
      if (failure === "oversized-supervisor") options.supervisorInstanceId = "s".repeat(129)
      if (failure === "open") options.admission = "open"
      if (failure === "invented-authority") options.authorized = true
      const before = await readFile(f.options.originalPath),
        files = await readdir(f.root)
      await expect(inspectSupervisorIndependentComposition(options)).rejects.toThrow()
      expect(await readFile(f.options.originalPath)).toEqual(before)
      expect(await readdir(f.root)).toEqual(files)
    }
  )

  it.each(["one-zero", "full-block-padding"])(
    "rejects effective HMAC key alias $0",
    async (alias) => {
      const f = await fixture()
      f.options.originalSigningSecret = "x".repeat(32)
      f.options.independentSigningSecret =
        f.options.originalSigningSecret + "\0".repeat(alias === "one-zero" ? 1 : 32)
      const tag = (key: string) =>
        createHmac("sha256", key).update("composition-test").digest("hex")
      expect(tag(f.options.originalSigningSecret)).toBe(tag(f.options.independentSigningSecret))
      const before = await readFile(f.options.originalPath),
        files = await readdir(f.root)
      await expect(inspectSupervisorIndependentComposition(f.options)).rejects.toThrow(
        "keys must differ"
      )
      expect(await readFile(f.options.originalPath)).toEqual(before)
      expect(await readdir(f.root)).toEqual(files)
    }
  )

  it("hashes keys longer than the HMAC block instead of truncating their shared prefix", async () => {
    const f = await fixture()
    f.options.originalSigningSecret = "x".repeat(65)
    f.options.independentSigningSecret = f.options.originalSigningSecret + "\0"
    const tag = (key: string) => createHmac("sha256", key).update("composition-test").digest("hex")
    expect(tag(f.options.originalSigningSecret)).not.toBe(tag(f.options.independentSigningSecret))
    expect(await inspectSupervisorIndependentComposition(f.options)).toMatchObject({
      productionEligible: false,
    })
  })
})
