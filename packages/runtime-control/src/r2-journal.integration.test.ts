import { mkdtemp, rm } from "node:fs/promises"
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
} from "./independent-journal"
import { R2ConditionalObjectStore } from "./r2-store"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("conditional R2 adapter with authority journal", () => {
  it("replays a lost write acknowledgement without duplicating the signed intent", async () => {
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
        if (loseAcknowledgement && key.includes("/records/")) {
          loseAcknowledgement = false
          throw new Error("synthetic lost response")
        }
        return {}
      },
    }
    const payloadSchema = z.object({ action: z.string() }).strict()
    const local = new SignedJournal(join(root, "local.jsonl"), "l".repeat(48), (value) =>
      authorityEventSchema(payloadSchema).parse(value)
    )
    let mirrored: AuthorityHead | null = null
    const mirroredRecords = new Map<number, JournalRecord<unknown>>()
    const journal = new IndependentAuthorityJournal({
      local,
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
          if (JSON.stringify(previous) !== JSON.stringify(mirrored)) return "conflict" as const
          mirrored = next
          mirroredRecords.set(record.sequence, structuredClone(record))
          return "written" as const
        },
      },
      epochId: "epoch-2",
      supervisorInstanceId: "supervisor-1",
      signingSecret: "s".repeat(48),
      payloadSchema,
      authorize: async () => true,
    })
    const intent = {
      epochId: "epoch-2",
      operationId: "operation-1",
      scanId: "scan-1",
      workspaceId: "workspace-1",
      attemptId: "attempt-1",
      eventId: "command-1",
      payload: { action: "START" },
    }
    await expect(journal.appendIntent(intent)).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
    const result = await journal.appendIntent(intent)
    expect(result.sequence).toBe(1)
    expect(await local.load()).toHaveLength(1)
    expect(objects.size).toBe(2)
    expect(writes).toBe(2)
  })
})
