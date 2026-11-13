import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { SignedJournal, type JournalRecord } from "./journal"
import {
  IndependentAuthorityJournal,
  authorityEventSchema,
  type AuthorityHead,
  type IndependentAuthorityJournalOptions,
} from "./independent-journal"
import { R2ConditionalObjectStore } from "./r2-store"
import { canonicalJson } from "./canonical-json"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("conditional R2 adapter with authority journal", () => {
  it.each([
    { boundary: "record", restart: false },
    { boundary: "head", restart: false },
    { boundary: "mirror", restart: false },
    { boundary: "record", restart: true },
    { boundary: "head", restart: true },
    { boundary: "mirror", restart: true },
  ])(
    "confirms exact signed intent after lost $boundary acknowledgement (restart=$restart)",
    async ({ boundary, restart }) => {
      const root = await mkdtemp(join(tmpdir(), "r2-authority-fixture-"))
      roots.push(root)
      const objects = new Map<string, { bytes: Buffer; etag: string }>()
      let writes = 0
      let loseAcknowledgement = true
      const client = {
        async send(command: GetObjectCommand | PutObjectCommand) {
          const key = command.input.Key!
          const current = objects.get(key)
          if (command instanceof GetObjectCommand) {
            if (!current) throw { $metadata: { httpStatusCode: 404 } }
            return {
              ETag: current.etag,
              ContentLength: current.bytes.length,
              Body: Readable.from([current.bytes]),
            }
          }
          if (
            (command.input.IfNoneMatch === "*" && current) ||
            (command.input.IfMatch && command.input.IfMatch !== current?.etag)
          ) {
            throw { $metadata: { httpStatusCode: 412 } }
          }
          writes += 1
          const bytes = Buffer.from(command.input.Body as Uint8Array)
          objects.set(key, { bytes, etag: `"etag-${writes}"` })
          if (
            loseAcknowledgement &&
            ((boundary === "record" && key.includes("/records/")) ||
              (boundary === "head" && key.endsWith("/head")))
          ) {
            loseAcknowledgement = false
            throw new Error("synthetic lost response")
          }
          return {}
        },
      }
      const payloadSchema = z.object({ action: z.string() }).strict()
      const path = join(root, "local.jsonl")
      const createLocal = () =>
        new SignedJournal(path, "l".repeat(48), (value) =>
          authorityEventSchema(payloadSchema).parse(value)
        )
      let local = createLocal()
      let mirrored: AuthorityHead | null = null
      const mirroredRecords = new Map<number, JournalRecord<unknown>>()
      const options: Omit<IndependentAuthorityJournalOptions<{ action: string }>, "local"> = {
        store: new R2ConditionalObjectStore(
          client as unknown as Pick<S3Client, "send">,
          "private-authority"
        ),
        mirror: {
          async readHead() {
            return mirrored
          },
          async readRecord(sequence) {
            return mirroredRecords.get(sequence) ?? null
          },
          async compareAndAppend(previous, next, record) {
            if (
              canonicalJson(next) === canonicalJson(mirrored) &&
              canonicalJson(mirroredRecords.get(record.sequence)) === canonicalJson(record)
            )
              return "written" as const
            if (canonicalJson(previous) !== canonicalJson(mirrored)) return "conflict" as const
            mirrored = next
            mirroredRecords.set(record.sequence, structuredClone(record))
            if (boundary === "mirror" && loseAcknowledgement) {
              loseAcknowledgement = false
              throw new Error("synthetic lost commit reply")
            }
            return "written" as const
          },
        },
        epochId: "epoch-2",
        supervisorInstanceId: "supervisor-1",
        signingSecret: "s".repeat(48),
        payloadSchema,
        authorize: async () => true,
      }
      let journal = new IndependentAuthorityJournal({ ...options, local })
      const intent = {
        epochId: "epoch-2",
        operationId: "operation-1",
        scanId: "scan-1",
        workspaceId: "workspace-1",
        attemptId: "attempt-1",
        eventId: "command-1",
        payload: { action: "START" },
      }
      try {
        await expect(journal.appendIntent(intent)).rejects.toMatchObject({
          code: "AUTHORITY_UNKNOWN",
        })
        const original = (await local.load())[0]!,
          originalBytes = await readFile(path)
        if (restart) {
          await local.close()
          local = createLocal()
          journal = new IndependentAuthorityJournal({ ...options, local })
        }
        expect(await journal.appendIntent(intent)).toEqual(original)
        expect(await readFile(path)).toEqual(originalBytes)
        expect(await local.load()).toHaveLength(1)
        expect(objects.size).toBe(3)
        expect(writes).toBe(3)
        expect([...objects.keys()].some((key) => key.endsWith("/acknowledgements/1"))).toBe(true)
      } finally {
        await local.close()
      }
    }
  )
})
