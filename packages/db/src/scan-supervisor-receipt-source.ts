import { request } from "node:http"
import { isAbsolute } from "node:path"
import { z } from "zod"
import {
  supervisorJournalCursorSchema,
  type SupervisorJournalCursor,
} from "@lyrashield/runtime-control"
import {
  checkReceiptKeys,
  receiptFailure,
  type SupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"

const identity = z.string().min(1).max(128)
const protectedSourceSchema = z
  .object({
    connectionString: z.string().min(1),
    streamId: identity,
    authorityEpochId: identity,
    supervisorInstanceId: identity,
    originalSigningSecret: z.string().min(32),
    originalKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
    wrapperSigningSecret: z.string().min(32),
    wrapperKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
    controlToken: z
      .string()
      .min(32)
      .refine((value) => !/[\r\n]/.test(value)),
    transport: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("unix"), socketPath: z.string().refine(isAbsolute) }).strict(),
      z.object({ kind: z.literal("loopback"), port: z.number().int().min(1).max(65535) }).strict(),
    ]),
  })
  .strict()
export type ProtectedSupervisorReceiptSource = z.infer<typeof protectedSourceSchema>

/** Root-owned installation only. Signed journal verification remains mandatory downstream. */
export function createProtectedSupervisorReceiptAuthority(
  input: unknown
): SupervisorReceiptAuthority {
  const parsed = protectedSourceSchema.safeParse(input)
  if (!parsed.success) receiptFailure("SUPERVISOR_SOURCE_CONFIGURATION_UNAVAILABLE")
  const config = parsed.data
  const authority: SupervisorReceiptAuthority = {
    ...config,
    readJournal: (cursor) => readProtectedJournal(config, cursor),
  }
  checkReceiptKeys(authority)
  return Object.freeze(authority)
}

function readProtectedJournal(
  config: ProtectedSupervisorReceiptSource,
  cursor: SupervisorJournalCursor
): Promise<unknown> {
  cursor = supervisorJournalCursorSchema.parse(cursor)
  if (
    cursor.epochId !== config.authorityEpochId ||
    cursor.supervisorInstanceId !== config.supervisorInstanceId
  )
    receiptFailure("SUPERVISOR_SOURCE_SCOPE_MISMATCH")
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(cursor))
    if (value !== undefined) params.set(key, String(value))
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("SUPERVISOR_SOURCE_READ_UNAVAILABLE"))
    const call = request(
      {
        ...(config.transport.kind === "unix"
          ? { socketPath: config.transport.socketPath }
          : { hostname: "127.0.0.1", port: config.transport.port }),
        method: "GET",
        path: `/v1/journal?${params.toString()}`,
        headers: { authorization: `Bearer ${config.controlToken}`, accept: "application/json" },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on("error", fail)
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 8 * 1024 * 1024) {
            call.destroy()
            fail()
          } else chunks.push(chunk)
        })
        response.on("end", () => {
          if (
            response.statusCode !== 200 ||
            response.headers["content-type"]?.split(";")[0] !== "application/json"
          )
            return fail()
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
          } catch {
            fail()
          }
        })
      }
    )
    const deadline = setTimeout(() => {
      call.destroy()
      fail()
    }, 10_000)
    call.once("close", () => clearTimeout(deadline))
    call.on("error", fail)
    call.end()
  })
}
