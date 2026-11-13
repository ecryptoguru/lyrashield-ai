import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { SignedJournal, type JournalRecord } from "./journal"

const roots: string[] = []
const journals: SignedJournal<{ value: string }>[] = []
const secret = "s".repeat(48)
const schema = z.object({ value: z.string() }).strict()
async function fixture(count = 0) {
  const root = await mkdtemp(join(tmpdir(), "journal-range-"))
  roots.push(root)
  const path = join(root, "journal.jsonl")
  const journal = new SignedJournal(path, secret, (value) => schema.parse(value))
  journals.push(journal)
  const records: JournalRecord<{ value: string }>[] = []
  for (let index = 0; index < count; index++)
    records.push(await journal.append({ value: `漢字-${index}` }))
  return { path, journal, records }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(journals.splice(0).map((journal) => journal.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const limits = { maxBytes: 8192, maxRecords: 7 }

describe("indexed signed journal ranges", () => {
  it("pages beyond 64 without whole-history reads or changing signed bytes, including after restart", async () => {
    const { path, journal, records } = await fixture(130)
    const bytes = await readFile(path)
    const whole = vi.spyOn(journal as unknown as { readAll(): Promise<unknown> }, "readAll")
    const all = []
    let after = 0
    for (;;) {
      const page = await journal.readRange(after, limits)
      expect(page.head).toEqual(records.at(-1))
      expect(page.previousHash).toBe(records[after - 1]?.hash ?? "0".repeat(64))
      all.push(...page.records)
      after += page.records.length
      if (!page.hasMore) break
    }
    expect(all).toEqual(records)
    expect(whole).not.toHaveBeenCalled()
    expect(await readFile(path)).toEqual(bytes)
    await journal.close()
    const restarted = new SignedJournal(path, secret, (value) => schema.parse(value))
    journals.push(restarted)
    expect((await restarted.readRange(123, limits)).records).toEqual(records.slice(123))
    expect((await restarted.readRange(130, limits)).records).toEqual([])
  })

  it("bounds requested bytes and count without latching or damaging the verified index", async () => {
    const { journal, records } = await fixture(80)
    await expect(journal.loadBounded({ maxBytes: 65536, maxRecords: 3 })).rejects.toThrow(/count/)
    await expect(journal.readRange(0, { maxBytes: 1, maxRecords: 1 })).rejects.toThrow(/byte/)
    const size = Buffer.byteLength(JSON.stringify(records[0]) + "\n")
    const headSize = Buffer.byteLength(JSON.stringify(records.at(-1)) + "\n")
    const page = await journal.readRange(0, { maxBytes: size + headSize, maxRecords: 100 })
    expect(page.records).toEqual(records.slice(0, 1))
    expect(page.hasMore).toBe(true)
    const tail = await journal.append({ value: "next" })
    expect(tail.sequence).toBe(81)
    expect((await journal.readRange(80, limits)).records).toEqual([tail])
  })

  it("rejects a validly signed replacement outside the selected page and latches the writer", async () => {
    const { path, journal } = await fixture(70)
    const other = await fixture(70)
    await writeFile(path, await readFile(other.path))
    await expect(journal.readRange(65, limits)).rejects.toThrow(/changed/)
    await expect(journal.append({ value: "must not append" })).rejects.toThrow(/changed/)
  })

  it("rejects same-length mutation even when it is outside the requested range", async () => {
    const { path, journal } = await fixture(70)
    const file = await open(path, "r+")
    try {
      await file.write(Buffer.from("X"), 0, 1, 20)
    } finally {
      await file.close()
    }
    await expect(journal.readRange(65, limits)).rejects.toThrow(/changed/)
  })

  it("rejects replacement by symlink without reading its target", async () => {
    const { path, journal } = await fixture(1)
    const target = join(roots.at(-1)!, "other")
    await writeFile(target, "private target")
    await rm(path)
    await symlink(target, path)
    await expect(journal.readRange(0, limits)).rejects.toThrow()
    expect(await readFile(target, "utf8")).toBe("private target")
  })

  it("fences genesis, invalid selectors and overlapping writer ownership", async () => {
    const { path, journal } = await fixture()
    expect(await journal.readRange(0, limits)).toEqual({
      records: [],
      head: null,
      previousHash: "0".repeat(64),
      hasMore: false,
    })
    await expect(journal.readRange(-1, limits)).rejects.toThrow(/invalid/)
    await expect(journal.readRange(0, { ...limits, maxRecords: 101 })).rejects.toThrow(/invalid/)
    await expect(journal.readRange(1, limits)).rejects.toThrow(/beyond/)
    const other = new SignedJournal(path, secret, (value) => schema.parse(value))
    journals.push(other)
    await expect(other.readRange(0, limits)).rejects.toThrow(/writer|lock/)
    await writeFile(path, "\n", { mode: 0o600 })
    await expect(journal.readRange(0, limits)).rejects.toThrow(/appeared/)
  })
})
