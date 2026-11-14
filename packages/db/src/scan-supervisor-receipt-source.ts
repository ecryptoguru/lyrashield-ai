import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"
import { request } from "node:http"
import { isAbsolute } from "node:path"
import { z } from "zod"
import {
  supervisorJournalCursorSchema,
  commandStatusSchema,
  supervisorCommandResultSchema,
  supervisorAttemptProofInputSchema,
  verifySupervisorAttemptProof,
  validateSupervisorAttemptProofPublicKey,
  type SupervisorAttemptProofInput,
  type SupervisorJournalCursor,
  nativeEngineResultInputSchema,
  nativeEngineResultChunkSchema,
  type NativeEngineResultChunk,
} from "@lyrashield/runtime-control"
import {
  checkReceiptKeys,
  receiptFailure,
  type SupervisorReceiptAuthority,
  type SupervisorAttemptProofAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"

const identity = z.string().min(1).max(128)
const protectedSourceSchema = z
  .object({
    connectionString: z.string().min(1),
    streamId: identity,
    authorityEpochId: identity,
    supervisorInstanceId: identity,
    attemptProofPublicKey: z
      .string()
      .max(1024)
      .transform(validateSupervisorAttemptProofPublicKey)
      .optional(),
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

const proofSourceSchema = protectedSourceSchema
  .omit({
    connectionString: true,
    originalSigningSecret: true,
    wrapperSigningSecret: true,
  })
  .extend({
    attemptProofPublicKey: z.string().max(1024).transform(validateSupervisorAttemptProofPublicKey),
  })
  .strict()

/** Broker receives only an installed public pin and scoped private-service methods. */
export function createProtectedSupervisorAttemptProofAuthority(
  input: unknown
): SupervisorAttemptProofAuthority & {
  consume(operationId: string, workerCredential?: string): Promise<unknown>
  deliverCommand(input: unknown, workerCredential?: string): Promise<unknown>
  readResult(input: unknown, workerCredential: string): Promise<NativeEngineResultChunk>
} {
  const parsed = proofSourceSchema.safeParse(input)
  if (!parsed.success) receiptFailure("SUPERVISOR_SOURCE_CONFIGURATION_UNAVAILABLE")
  const config = parsed.data
  return Object.freeze({
    streamId: config.streamId,
    authorityEpochId: config.authorityEpochId,
    supervisorInstanceId: config.supervisorInstanceId,
    originalKeyHash: config.originalKeyHash,
    wrapperKeyHash: config.wrapperKeyHash,
    attemptProofPublicKey: config.attemptProofPublicKey,
    deliverCommand: async (value: unknown, workerCredential?: string) => {
      const input = z
        .object({
          operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/),
          commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/),
        })
        .strict()
        .parse(value)
      const credential =
        workerCredential === undefined
          ? undefined
          : z
              .string()
              .min(32)
              .max(1024)
              .refine((value) => value.trim() === value && !/[\r\n]/.test(value))
              .parse(workerCredential)
      const status = supervisorCommandResultSchema.parse(
        await readProtectedSource(
          config,
          "/v1/commands",
          { ...input, ...(credential ? { workerCredential: credential } : {}) },
          16 * 1024
        )
      )
      if (status.commandId !== input.commandId) receiptFailure("SUPERVISOR_SOURCE_SCOPE_MISMATCH")
      return status
    },
    readResult: async (value: unknown, workerCredential: string) => {
      const input = nativeEngineResultInputSchema.parse(value)
      const credential = z
        .string()
        .min(32)
        .max(1024)
        .refine((value) => value.trim() === value && !/[\r\n]/.test(value))
        .parse(workerCredential)
      const result = nativeEngineResultChunkSchema.parse(
        await readProtectedSource(
          config,
          "/v1/result",
          { ...input, workerCredential: credential },
          2 * 1024 * 1024
        )
      )
      if (
        result.operationId !== input.operationId ||
        result.attemptId !== input.attemptId ||
        (result.kind === "available" && result.offset !== input.offset)
      )
        receiptFailure("SUPERVISOR_SOURCE_SCOPE_MISMATCH")
      return result
    },
    readAttemptProof: async (value: SupervisorAttemptProofInput) => {
      const request = supervisorAttemptProofInputSchema.parse(value)
      if (request.authorityEpochId !== config.authorityEpochId)
        receiptFailure("SUPERVISOR_SOURCE_SCOPE_MISMATCH")
      const proof = await readProtectedSource(config, "/v1/attempt-proof", request, 16 * 1024)
      return verifySupervisorAttemptProof(proof, request, {
        publicKey: config.attemptProofPublicKey,
        supervisorInstanceId: config.supervisorInstanceId,
      })
    },
    consume: async (operationId: string, workerCredential?: string) => {
      const input = z
        .object({
          operationId: identity,
          workerCredential: z
            .string()
            .min(32)
            .max(1024)
            .refine((value) => value.trim() === value && !/[\r\n]/.test(value))
            .optional(),
        })
        .strict()
        .parse({ operationId, ...(workerCredential ? { workerCredential } : {}) })
      const value = await readProtectedSource(config, "/v1/consume-receipts", input, 32 * 1024)
      const result = z
        .object({
          operationId: identity,
          confirmedSequence: z.number().int().nonnegative().safe(),
          receipts: z.number().int().nonnegative().safe(),
          dispositions: z
            .array(
              z
                .object({
                  commandId: identity,
                  status: z.enum([
                    "UNKNOWN",
                    "PREPARED",
                    "STARTED",
                    "HELD",
                    "STOPPED",
                    "NEVER_DISPATCHED",
                  ]),
                  observedStatus: commandStatusSchema,
                })
                .strict()
            )
            .max(256),
        })
        .strict()
        .parse(value)
      if (result.operationId !== operationId) receiptFailure("SUPERVISOR_SOURCE_SCOPE_MISMATCH")
      return result
    },
  })
}

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
    readAttemptProof: async (value) => {
      const input = supervisorAttemptProofInputSchema.parse(value)
      if (input.authorityEpochId !== config.authorityEpochId)
        receiptFailure("SUPERVISOR_SOURCE_SCOPE_MISMATCH")
      const proof = await readProtectedSource(config, "/v1/attempt-proof", input, 16 * 1024)
      return verifySupervisorAttemptProof(proof, input, {
        publicKey: config.attemptProofPublicKey ?? "",
        supervisorInstanceId: config.supervisorInstanceId,
      })
    },
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
  return readProtectedSource(config, `/v1/journal?${params.toString()}`)
}

function readProtectedSource(
  config: Pick<ProtectedSupervisorReceiptSource, "transport" | "controlToken">,
  path: string,
  input?: object,
  maximumBytes = 8 * 1024 * 1024
): Promise<unknown> {
  const body = input ? Buffer.from(JSON.stringify(input)) : undefined
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("SUPERVISOR_SOURCE_READ_UNAVAILABLE"))
    const call = request(
      {
        ...(config.transport.kind === "unix"
          ? { socketPath: config.transport.socketPath }
          : { hostname: "127.0.0.1", port: config.transport.port }),
        method: body ? "POST" : "GET",
        path,
        headers: {
          authorization: `Bearer ${config.controlToken}`,
          accept: "application/json",
          ...(body
            ? { "content-type": "application/json", "content-length": body.byteLength }
            : {}),
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on("error", fail)
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > maximumBytes) {
            call.destroy()
            fail()
          } else chunks.push(chunk)
        })
        response.on("end", () => {
          if (
            (path === "/v1/consume-receipts" || path === "/v1/result") &&
            response.statusCode === 403 &&
            response.headers["content-type"]?.split(";")[0] === "application/json"
          ) {
            try {
              const refusal = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                code?: unknown
              }
              if (refusal.code === "WORKER_GRANT_INVALID")
                return reject(
                  new ScanDispatchAuthorityError(
                    "WORKER_GRANT_INVALID",
                    "Worker authority is unavailable"
                  )
                )
            } catch {
              /* Invalid error bodies disclose no private detail. */
            }
          }
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
    const deadline = setTimeout(
      () => {
        call.destroy()
        fail()
      },
      path === "/v1/commands" ? 30_000 : 10_000
    )
    call.once("close", () => clearTimeout(deadline))
    call.on("error", fail)
    call.end(body)
  })
}
