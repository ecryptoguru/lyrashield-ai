import {
  chmod,
  copyFile,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { SignedJournal } from "./journal"

const roots: string[] = []
const secret = "s".repeat(48)
const schema = z.object({ value: z.string() }).strict()
const parse = (value: unknown) => schema.parse(value)
const segmentOptions = { maxSegmentBytes: 1024 }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "journal-segments-"))
  roots.push(root)
  const path = join(root, "journal.jsonl")
  const journal = new SignedJournal(path, secret, parse, segmentOptions)
  return { root, path, journal }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("segmented signed journal", () => {
  it("continues an existing journal across bounded segments and preserves global cursors after restart", async () => {
    const { root, path, journal } = await fixture()
    const records = []
    for (let index = 0; index < 12; index++)
      records.push(await journal.append({ value: `${index}-${"x".repeat(300)}` }))
    const files = (await readdir(root)).filter((name) => name.startsWith("journal.jsonl.segment."))
    expect(files.length).toBeGreaterThan(1)
    const originals = await Promise.all(
      [path, ...files.map((file) => join(root, file))].map((file) => readFile(file))
    )
    expect((await journal.readRange(3, { maxBytes: 8192, maxRecords: 5 })).records).toEqual(
      records.slice(3, 8)
    )
    await expect(journal.confirmRecord(records[0]!)).resolves.toEqual(records[0])
    await journal.close()
    const restarted = new SignedJournal(path, secret, parse, segmentOptions)
    expect(await restarted.load()).toEqual(records)
    const next = await restarted.append({ value: "after restart" })
    expect(next.sequence).toBe(13)
    expect(next.previousHash).toBe(records.at(-1)!.hash)
    expect((await restarted.readRange(10, { maxBytes: 8192, maxRecords: 3 })).records).toEqual([
      ...records.slice(10),
      next,
    ])
    await restarted.close()
    const after = await Promise.all(
      [path, ...files.map((file) => join(root, file))].map((file) => readFile(file))
    )
    after.forEach((bytes, index) =>
      expect(bytes.subarray(0, originals[index]!.length)).toEqual(originals[index])
    )
  })

  it("returns the exact persisted record bytes across segments without reserialization", async () => {
    const { root, path, journal } = await fixture()
    const records = []
    for (let index = 0; index < 6; index++)
      records.push(await journal.append({ value: `${index}-${"字".repeat(100)}` }))
    const names = [
      path,
      ...(await readdir(root))
        .filter((name) => name.startsWith("journal.jsonl.segment."))
        .sort((a, b) => Number(a.split(".").at(-1)) - Number(b.split(".").at(-1)))
        .map((name) => join(root, name)),
    ]
    const persisted = Buffer.concat(await Promise.all(names.map((name) => readFile(name))))
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
    const result = await journal.readRawRange(1, { maxBytes: 8192, maxRecords: 4 })
    expect(result.range.records).toEqual(records.slice(1, 5))
    expect(result.records.map((bytes) => Buffer.from(bytes).toString("utf8"))).toEqual(
      persisted.slice(1, 5).map((line) => `${line}\n`)
    )
    const last = records[4]!
    const segmentFiles = await Promise.all(
      names.map(async (name) => ({
        name,
        lines: (await readFile(name, "utf8")).split("\n").filter(Boolean),
      }))
    )
    const selected = segmentFiles.find((file) =>
      file.lines.some((line) => JSON.parse(line).sequence === last.sequence)
    )!
    const index = selected.lines.findIndex((line) => JSON.parse(line).sequence === last.sequence)
    expect(result.endPosition).toEqual({
      segmentStartSequence: JSON.parse(selected.lines[0]!).sequence,
      byteOffsetAfterLastSealedRecord: Buffer.byteLength(
        selected.lines
          .slice(0, index + 1)
          .map((line) => `${line}\n`)
          .join("")
      ),
    })
    await journal.close()
  })

  it("fails closed when a middle segment disappears", async () => {
    const { root, path, journal } = await fixture()
    for (let index = 0; index < 8; index++)
      await journal.append({ value: `${index}-${"x".repeat(300)}` })
    await journal.close()
    const segments = (await readdir(root)).filter((name) =>
      name.startsWith("journal.jsonl.segment.")
    )
    expect(segments.length).toBeGreaterThan(1)
    await rm(join(root, segments[0]!))
    const restarted = new SignedJournal(path, secret, parse, segmentOptions)
    await expect(restarted.load()).rejects.toThrow(/chain|segment|sequence/i)
    await expect(restarted.append({ value: "must fail" })).rejects.toThrow()
  })

  it("rejects invalid UTF-8 that decodes to the same signed payload after restart", async () => {
    const { path, journal } = await fixture()
    await journal.append({ value: "\uFFFD" })
    await journal.close()

    const original = await readFile(path)
    const replacement = Buffer.from("\uFFFD", "utf8")
    const offset = original.indexOf(replacement)
    expect(offset).toBeGreaterThanOrEqual(0)
    const tampered = Buffer.concat([
      original.subarray(0, offset),
      Buffer.from([0xff]),
      original.subarray(offset + replacement.length),
    ])
    expect(tampered.toString("utf8")).toBe(original.toString("utf8"))
    await writeFile(path, tampered)

    const restarted = new SignedJournal(path, secret, parse, segmentOptions)
    await expect(restarted.load()).rejects.toThrow(/invalid utf-8/i)
    await expect(restarted.append({ value: "must fail" })).rejects.toThrow()
  })

  it("rejects a modified closed segment while the writer is active", async () => {
    const { root, journal } = await fixture()
    for (let index = 0; index < 8; index++)
      await journal.append({ value: `${index}-${"x".repeat(300)}` })
    const segment = (await readdir(root)).find((name) => name.startsWith("journal.jsonl.segment."))!
    const target = join(root, segment)
    await writeFile(
      target,
      (await readFile(target, "utf8")).replace(/"value":"\d+-/, '"value":"tampered-')
    )
    await expect(journal.readRange(6, { maxBytes: 8192, maxRecords: 2 })).rejects.toThrow(
      /changed|signature|hash/i
    )
    await expect(journal.append({ value: "must fail" })).rejects.toThrow()
  })

  it("does not bless a changed segment when a bounded history read stops early", async () => {
    const { path, journal } = await fixture()
    for (let index = 0; index < 8; index++)
      await journal.append({ value: `${index}-${"x".repeat(300)}` })
    await writeFile(path, (await readFile(path, "utf8")).replace('"value":"0-', '"value":"9-'))
    await expect(journal.loadBounded({ maxBytes: 8192, maxRecords: 2 })).rejects.toMatchObject({
      code: "JOURNAL_READ_LIMIT",
    })
    await expect(journal.readRange(6, { maxBytes: 8192, maxRecords: 2 })).rejects.toThrow(
      /changed/i
    )
  })

  it("rejects a reordered segment on restart", async () => {
    const { root, path, journal } = await fixture()
    for (let index = 0; index < 8; index++)
      await journal.append({ value: `${index}-${"x".repeat(300)}` })
    await journal.close()
    const segments = (await readdir(root)).filter((name) =>
      name.startsWith("journal.jsonl.segment.")
    )
    await rename(join(root, segments[0]!), join(root, "journal.jsonl.segment.999"))
    const restarted = new SignedJournal(path, secret, parse, segmentOptions)
    await expect(restarted.load()).rejects.toThrow(/chain|segment|sequence/i)
  })

  it("rejects a segment symlink without following its target", async () => {
    const { root, path, journal } = await fixture()
    for (let index = 0; index < 4; index++)
      await journal.append({ value: `${index}-${"x".repeat(300)}` })
    await journal.close()
    const segment = (await readdir(root)).find((name) => name.startsWith("journal.jsonl.segment."))!
    const target = join(root, "unrelated")
    await writeFile(target, "private target", { mode: 0o600 })
    await rm(join(root, segment))
    await symlink(target, join(root, segment))
    const restarted = new SignedJournal(path, secret, parse, segmentOptions)
    await expect(restarted.load()).rejects.toThrow()
    expect(await readFile(target, "utf8")).toBe("private target")
  })

  it("rejects a segment with unsafe permissions", async () => {
    const { root, path, journal } = await fixture()
    for (let index = 0; index < 4; index++)
      await journal.append({ value: `${index}-${"x".repeat(300)}` })
    await journal.close()
    const segment = (await readdir(root)).find((name) => name.startsWith("journal.jsonl.segment."))!
    await chmod(join(root, segment), 0o644)
    const restarted = new SignedJournal(path, secret, parse, segmentOptions)
    await expect(restarted.load()).rejects.toThrow(/permissions|ownership/)
  })

  it("rejects a newline-only intermediate base rather than adopting another journal", async () => {
    const { path } = await fixture()
    const separate = new SignedJournal(`${path}.segment.1`, secret, parse)
    await separate.append({ value: "foreign" })
    await separate.close()
    await writeFile(path, "\n", { mode: 0o600 })
    const original = new SignedJournal(path, secret, parse)
    await expect(original.load()).rejects.toThrow(/empty.*segment|segment.*empty/i)
  })

  it("continues after a crash left a newly created empty segment and rejects a torn record", async () => {
    const { path, journal } = await fixture()
    const first = await journal.append({ value: "before crash" })
    await journal.close()
    await writeFile(`${path}.segment.2`, "", { mode: 0o600 })
    const restarted = new SignedJournal(path, secret, parse, segmentOptions)
    const second = await restarted.append({ value: "after crash" })
    expect(second.sequence).toBe(2)
    expect(second.previousHash).toBe(first.hash)
    await restarted.close()
    await writeFile(`${path}.segment.3`, "{", { mode: 0o600 })
    const torn = new SignedJournal(path, secret, parse, segmentOptions)
    await expect(torn.load()).rejects.toThrow(/incomplete|invalid/)
  })

  it("keeps the writer fenced after the first sync of a new segment fails", async () => {
    const { path, journal } = await fixture()
    await journal.append({ value: "x".repeat(300) })
    const handle = await open(path, "r")
    const prototype = Object.getPrototypeOf(handle)
    await handle.close()
    vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("segment sync failed"))
    await expect(journal.append({ value: "x".repeat(300) })).rejects.toThrow("segment sync failed")
    await expect(journal.append({ value: "must fail" })).rejects.toThrow("segment sync failed")
    const overlapping = new SignedJournal(path, secret, parse, segmentOptions)
    await expect(overlapping.load()).rejects.toThrow(/writer|lock/)
  })

  it("rotates a legacy single-file journal without rewriting existing signed bytes", async () => {
    const { path, journal } = await fixture()
    const first = await journal.append({ value: "legacy" })
    await journal.close()
    const legacy = await readFile(path)
    const migrated = new SignedJournal(path, secret, parse, segmentOptions)
    const second = await migrated.append({ value: "x".repeat(690) })
    expect(second.previousHash).toBe(first.hash)
    expect(await readFile(path)).toEqual(legacy)
    expect(await migrated.load()).toEqual([first, second])
    await migrated.close()
  })

  it("restores the complete chain when every segment is copied", async () => {
    const { root, journal } = await fixture()
    const records = []
    for (let index = 0; index < 6; index++)
      records.push(await journal.append({ value: `${index}-${"x".repeat(300)}` }))
    await journal.close()
    const restoreRoot = await mkdtemp(join(tmpdir(), "journal-restore-"))
    roots.push(restoreRoot)
    const names = await readdir(root)
    await Promise.all(names.map((name) => copyFile(join(root, name), join(restoreRoot, name))))
    const restored = new SignedJournal(
      join(restoreRoot, "journal.jsonl"),
      secret,
      parse,
      segmentOptions
    )
    expect(await restored.load()).toEqual(records)
    const next = await restored.append({ value: "after restore" })
    expect(next.sequence).toBe(7)
    expect(next.previousHash).toBe(records.at(-1)!.hash)
    await restored.close()
  })
})
