import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { SignedJournal } from "./journal"

const roots: string[] = []
const payloadSchema = z.object({ kind: z.string(), value: z.number() }).strict()
const secret = "s".repeat(48)

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runtime-journal-test-"))
  roots.push(directory)
  return directory
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("SignedJournal", () => {
  it("fences overlapping writers and permits a verified graceful handover", async () => {
    const path = join(await root(), "exclusive.jsonl")
    const first = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    const overlap = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    await first.append({ kind: "prepare", value: 1 })
    await expect(overlap.append({ kind: "start", value: 2 })).rejects.toThrow(/lock|writer/i)
    await first.close()
    const next = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    const second = await next.append({ kind: "start", value: 2 })
    expect(second.sequence).toBe(2)
    await expect(first.append({ kind: "late", value: 3 })).rejects.toThrow(/closed/i)
    await next.close()
  })

  it("does not adopt a stale lock or follow a journal symlink", async () => {
    const directory = await root()
    const path = join(directory, "supervisor.jsonl")
    await writeFile(`${path}.lock`, "stale owner")
    const blocked = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    await expect(blocked.load()).rejects.toThrow(/lock|writer/i)
    await rm(`${path}.lock`)
    const other = join(directory, "other.jsonl")
    await writeFile(other, "")
    await symlink(other, path)
    const unsafe = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    await expect(unsafe.load()).rejects.toThrow()
    expect(await readFile(other, "utf8")).toBe("")
  })

  it("fsyncs a monotonic signed chain and restores it", async () => {
    const path = join(await root(), "supervisor.jsonl")
    const journal = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    const first = await journal.append({ kind: "prepare", value: 1 })
    const second = await journal.append({ kind: "start", value: 2 })
    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(second.previousHash).toBe(first.hash)
    expect(second.hash).not.toBe(first.hash)
    expect(second.signature).toMatch(/^[a-f0-9]{64}$/)

    await journal.close()
    const reloaded = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    await expect(reloaded.load()).resolves.toEqual([first, second])
  })

  it("rejects a modified receipt instead of accepting stale evidence", async () => {
    const path = join(await root(), "supervisor.jsonl")
    const journal = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    await journal.append({ kind: "prepare", value: 1 })
    const raw = await readFile(path, "utf8")
    await journal.close()
    await writeFile(path, raw.replace('"value":1', '"value":9'), "utf8")
    const reloaded = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    await expect(reloaded.load()).rejects.toThrow(/signature|hash/)
  })

  it("rejects incomplete trailing writes", async () => {
    const path = join(await root(), "supervisor.jsonl")
    const journal = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    await journal.append({ kind: "prepare", value: 1 })
    await journal.close()
    await writeFile(path, `${await readFile(path, "utf8")}{"version":1`, "utf8")
    const reloaded = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    await expect(reloaded.load()).rejects.toThrow(/incomplete|invalid/)
  })
})

describe("SignedJournal failure latching", () => {
  it("latches unusable after a write failure instead of reusing a sequence", async () => {
    const directory = await root()
    const path = join(directory, "supervisor.jsonl")
    const journal = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    const first = await journal.append({ kind: "prepare", value: 1 })
    expect(first.sequence).toBe(1)

    // Make appends transiently impossible, then restore the directory. A
    // latched journal must keep failing closed instead of appending onto a
    // file whose last append was lost.
    await rm(directory, { recursive: true, force: true })
    await expect(journal.append({ kind: "start", value: 2 })).rejects.toThrow()

    const { mkdir } = await import("node:fs/promises")
    await mkdir(directory, { recursive: true })
    await expect(journal.append({ kind: "start", value: 2 })).rejects.toThrow()
    await expect(journal.load()).rejects.toThrow()
    await expect(readFile(path, "utf8")).rejects.toThrow()
  })

  it("latches closed after an integrity rejection during load", async () => {
    const directory = await root()
    const path = join(directory, "provider.jsonl")
    const journal = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    await journal.append({ kind: "prepare", value: 1 })
    await journal.close()
    await writeFile(path, `${await readFile(path, "utf8")}{"version":1`, "utf8")
    const reloaded = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    await expect(reloaded.load()).rejects.toThrow(/incomplete|invalid/)
    await expect(reloaded.load()).rejects.toThrow()
    await expect(reloaded.append({ kind: "start", value: 2 })).rejects.toThrow()
  })
})

describe("SignedJournal explicit replay confirmation", () => {
  it("fsyncs exact bytes only on explicit confirmation and preserves sequence", async () => {
    const path = join(await root(), "original.jsonl")
    const journal = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    const record = await journal.append({ kind: "prepare", value: 1 })
    const bytes = await readFile(path, "utf8")
    const handle = await open(path, "r")
    const prototype = Object.getPrototypeOf(handle)
    await handle.close()
    const sync = vi.spyOn(prototype, "sync")
    expect(await journal.load()).toEqual([record])
    expect(sync).not.toHaveBeenCalled()
    expect(await journal.confirmRecord(record)).toEqual(record)
    expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(await readFile(path, "utf8")).toBe(bytes)
    const next = await journal.append({ kind: "start", value: 2 })
    expect(next.sequence).toBe(2)
    expect(next.previousHash).toBe(record.hash)
  })

  it("latches on fsync failure without signing a replacement record", async () => {
    const path = join(await root(), "original.jsonl")
    const journal = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    const record = await journal.append({ kind: "prepare", value: 1 })
    const bytes = await readFile(path, "utf8")
    const handle = await open(path, "r")
    const prototype = Object.getPrototypeOf(handle)
    await handle.close()
    vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("fsync unavailable"))
    await expect(journal.confirmRecord(record)).rejects.toThrow("fsync unavailable")
    await expect(journal.append({ kind: "start", value: 2 })).rejects.toThrow("fsync unavailable")
    expect(await readFile(path, "utf8")).toBe(bytes)
  })

  it("rejects confirmation with a changed envelope", async () => {
    const path = join(await root(), "original.jsonl")
    const journal = new SignedJournal(path, secret, (value) => payloadSchema.parse(value))
    const record = await journal.append({ kind: "prepare", value: 1 })
    await expect(journal.confirmRecord({ ...record, signature: "f".repeat(64) })).rejects.toThrow(
      "does not match"
    )
    await expect(journal.load()).rejects.toThrow("does not match")
  })
})
