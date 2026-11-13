import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { authorityEventSchema } from "./independent-journal"
import { SignedJournal } from "./journal"
import { createJournalSeal } from "./journal-seal"
import { auditJournalSealArchives } from "./journal-seal-archive"

const roots: string[] = []
const originalKey = "o".repeat(48),
  wrapperKey = "w".repeat(48),
  sealKey = "s".repeat(48)
const payload = z.object({ value: z.string() }).strict()
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "seal-archive-"))
  roots.push(root)
  const original = new SignedJournal(join(root, "original"), originalKey, (value) =>
    payload.parse(value)
  )
  const wrapper = new SignedJournal(join(root, "wrapper"), wrapperKey, (value) =>
    authorityEventSchema(z.unknown()).parse(value)
  )
  const first = await original.append({ value: "before" })
  const second = await original.append({ value: "after" })
  const records = []
  for (const source of [first, second])
    records.push(
      await wrapper.append({
        epochId: "epoch-1",
        operationId: "operation-1",
        scanId: "scan-1",
        workspaceId: "workspace-1",
        attemptId: "attempt-1",
        eventId: `source-${source.sequence}`,
        payload: source,
      })
    )
  const originalBytes = Buffer.concat(
    (await original.readRawRange(0, { maxBytes: 8192, maxRecords: 2 })).records
  )
  const wrapperBytes = Buffer.concat(
    (await wrapper.readRawRange(0, { maxBytes: 8192, maxRecords: 2 })).records
  )
  const seal = createJournalSeal(
    {
      schema: "lyrashield-journal-seal/1",
      epochId: "epoch-1",
      supervisorInstanceId: "supervisor-1",
      revision: 1,
      firstSequence: 1,
      lastSequence: 2,
      previousSealHash: "0".repeat(64),
      originalPreviousHash: "0".repeat(64),
      originalLastHash: second.hash,
      wrapperPreviousHash: "0".repeat(64),
      wrapperLastHash: records[1]!.hash,
      originalSegmentSha256: hash(originalBytes),
      wrapperSegmentSha256: hash(wrapperBytes),
      originalBytes: originalBytes.length,
      wrapperBytes: wrapperBytes.length,
      recordCount: 2,
      independentHeadHash: "3".repeat(64),
      observedJournalAckHash: "4".repeat(64),
    },
    sealKey
  )
  const prefix = `epochs/epoch-1/supervisors/supervisor-1/seal-segments/${seal.sealHash}`
  const objects = new Map([
    [prefix + "/original", originalBytes],
    [prefix + "/wrapper", wrapperBytes],
  ])
  const store = {
    readBounded: async (key: string, maxBytes: number) => {
      const bytes = objects.get(key)
      if (!bytes) return null
      if (bytes.byteLength > maxBytes) throw new Error("oversized")
      return { bytes, etag: `etag-${hash(bytes)}` }
    },
  }
  await original.close()
  await wrapper.close()
  return { seal, store, objects, prefix }
}

describe("sealed journal archive audit", () => {
  it("authenticates exact retained bytes and both cross-linked record chains", async () => {
    const f = await fixture()
    const result = await auditJournalSealArchives(f.seal, f.store, {
      originalSigningSecret: originalKey,
      wrapperSigningSecret: wrapperKey,
      sealSigningSecret: sealKey,
      validateOriginal: (value) => payload.parse(value),
    })
    expect(result.originals.map((record) => record.payload.value)).toEqual(["before", "after"])
    expect(result.wrappers.map((record) => record.sequence)).toEqual([1, 2])
  })
  it.each(["missing", "changed"])(
    "reports %s archives unavailable or conflicting",
    async (damage) => {
      const f = await fixture()
      if (damage === "missing") f.objects.delete(f.prefix + "/wrapper")
      else f.objects.set(f.prefix + "/wrapper", Buffer.from("changed"))
      await expect(
        auditJournalSealArchives(f.seal, f.store, {
          originalSigningSecret: originalKey,
          wrapperSigningSecret: wrapperKey,
          sealSigningSecret: sealKey,
          validateOriginal: (value) => payload.parse(value),
        })
      ).rejects.toThrow()
    }
  )
})
