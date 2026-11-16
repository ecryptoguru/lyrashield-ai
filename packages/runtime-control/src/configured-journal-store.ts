import { S3Client } from "@aws-sdk/client-s3"
import { z } from "zod"
import { R2ConditionalObjectStore } from "./r2-store"

const storageSchema = z
  .object({
    schema: z.literal("lyrashield-supervisor-r2-journal-storage/1"),
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    accessKeyId: z.string().regex(/^[a-f0-9]{32}$/),
    secretAccessKey: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

/** Protected supervisor configuration; the endpoint is always the pinned R2 account. */
export function createConfiguredJournalStore(input: string, maximumBytes = 128 * 1024) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 4 * 1024 * 1024)
    throw new Error("Protected supervisor journal storage is unavailable")
  let config: z.infer<typeof storageSchema>
  try {
    if (Buffer.byteLength(input) > 4096) throw new Error()
    config = storageSchema.parse(JSON.parse(input))
  } catch {
    throw new Error("Protected supervisor journal storage is unavailable")
  }
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    maxAttempts: 1,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
  return {
    store: new R2ConditionalObjectStore(client, config.bucket, maximumBytes, 5000),
    close: () => client.destroy(),
  }
}
