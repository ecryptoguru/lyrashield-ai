import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { SignedJournal } from "./journal"
import { readSignedJournalTail } from "./journal-tail"

const roots: string[] = []
const secret = "s".repeat(48)
const payload = z.object({ value: z.string() }).strict()
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(count = 8) {
  const root = await mkdtemp(join(tmpdir(), "journal-tail-"))
  roots.push(root)
  const path = join(root, "journal")
  const journal = new SignedJournal(path, secret, (value) => payload.parse(value), {
    maxSegmentBytes: 1024,
  })
  const records = []
  for (let i = 0; i < count; i++)
    records.push(await journal.append({ value: `${i}-${"x".repeat(300)}` }))
  const checkpoint = await journal.readRawRange(0, { maxBytes: 8192, maxRecords: 3 })
  const after = records[2]!
  return { root, path, journal, records, position: checkpoint.endPosition!, after }
}

describe("bounded signed journal tail", () => {
  it("verifies only the signed suffix across local rotation and reports unconfirmed later bytes", async () => {
    const f = await fixture()
    const tail = await readSignedJournalTail(f.path, secret, (value) => payload.parse(value), {
      position: f.position,
      afterSequence: f.after.sequence,
      afterHash: f.after.hash,
      expectedSequence: 7,
      expectedHash: f.records[6]!.hash,
      maxRecords: 8,
      maxBytes: 8192,
    })
    expect(tail.records).toEqual(f.records.slice(3, 7))
    expect(tail.hasUnconfirmedSuffix).toBe(true)
    await f.journal.close()
  })
  it("fails closed if the expected tail segment is missing or capped", async () => {
    const f = await fixture()
    const options = {
      position: f.position,
      afterSequence: f.after.sequence,
      afterHash: f.after.hash,
      expectedSequence: 8,
      expectedHash: f.records[7]!.hash,
      maxRecords: 2,
      maxBytes: 8192,
    }
    await expect(
      readSignedJournalTail(f.path, secret, (value) => payload.parse(value), options)
    ).rejects.toThrow(/limit/i)
    await f.journal.close()
    const names = (await readdir(f.root)).filter((name) => name.startsWith("journal.segment."))
    const last = names
      .sort((a, b) => Number(a.split(".").at(-1)) - Number(b.split(".").at(-1)))
      .at(-1)!
    await rm(join(f.root, last))
    await expect(
      readSignedJournalTail(f.path, secret, (value) => payload.parse(value), {
        ...options,
        maxRecords: 8,
      })
    ).rejects.toThrow(/unavailable|missing/i)
  })
  it("rejects tampering in the selected tail", async () => {
    const f = await fixture()
    await f.journal.close()
    const segment = join(f.root, `journal.segment.${f.after.sequence + 1}`)
    await writeFile(
      segment,
      (await readFile(segment, "utf8")).replace('"value":"3-', '"value":"9-')
    )
    await expect(
      readSignedJournalTail(f.path, secret, (value) => payload.parse(value), {
        position: f.position,
        afterSequence: f.after.sequence,
        afterHash: f.after.hash,
        expectedSequence: 8,
        expectedHash: f.records[7]!.hash,
        maxRecords: 8,
        maxBytes: 8192,
      })
    ).rejects.toThrow(/signature|hash|chain/i)
  })
  it("authenticates the exact record immediately before the pinned tail offset", async () => {
    const f = await fixture()
    await f.journal.close()
    const segment =
      f.position.segmentStartSequence === 1
        ? f.path
        : `${f.path}.segment.${f.position.segmentStartSequence}`
    await writeFile(
      segment,
      (await readFile(segment, "utf8")).replace('"value":"2-', '"value":"9-')
    )
    await expect(
      readSignedJournalTail(f.path, secret, (value) => payload.parse(value), {
        position: f.position,
        afterSequence: f.after.sequence,
        afterHash: f.after.hash,
        expectedSequence: 7,
        expectedHash: f.records[6]!.hash,
        maxRecords: 8,
        maxBytes: 8192,
      })
    ).rejects.toThrow(/signature|hash|anchor/i)
  })
})
