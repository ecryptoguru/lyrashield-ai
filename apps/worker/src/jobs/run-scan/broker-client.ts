import { request } from "node:http"
import { z } from "zod"
import type { WorkerBrokerInstallation } from "./broker-authority"

const socketPath = "/run/lyrashield/broker.sock"
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
const attempt = z
  .object({
    operationId: id,
    attemptId: id,
    workerInstanceId: id,
    workerGrantId: id,
    authorityEpochId: id,
  })
  .strict()
const prepareInput = attempt.omit({ attemptId: true }).extend({ expiresAt: z.date() }).strict()
const stopInput = attempt
  .extend({ reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/) })
  .strict()
const unknown = z
  .object({
    kind: z.literal("unknown"),
    operationId: id,
    reasonCode: z.enum([
      "COMMIT_OUTCOME_UNKNOWN",
      "COMMIT_OBSERVED_AFTER_AUTHORITY_DEADLINE",
      "PREPARATION_ACKNOWLEDGEMENT_DEADLINE",
    ]),
  })
  .strict()
const prepareResult = z.discriminatedUnion("kind", [
  unknown,
  z
    .object({ kind: z.literal("waiting"), operationId: id, state: z.literal("WAITING_CAPACITY") })
    .strict(),
  z
    .object({
      kind: z.literal("committed"),
      operationId: id,
      state: z.literal("PREPARING"),
      attemptId: id,
      commandId: id,
      authorityAcceptedAt: z
        .string()
        .datetime({ offset: true })
        .transform((value) => new Date(value)),
      authorityDeadlineAt: z
        .string()
        .datetime({ offset: true })
        .transform((value) => new Date(value)),
      eligibility: z.literal("CHECKED_INTENT_ONLY"),
    })
    .strict(),
])
const statusResult = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("unknown"),
      operationId: id,
      reasonCode: z.literal("STATUS_UNAVAILABLE"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("available"),
      operationId: id,
      state: z.enum([
        "QUEUED",
        "WAITING_CAPACITY",
        "PREPARING",
        "PREPARED",
        "START_PENDING",
        "ACTIVE",
        "STOPPING",
        "TERMINATED",
        "REJECTED",
        "UNKNOWN",
      ]),
      attemptId: id.nullable(),
      preparationEligibility: z.enum(["UNAVAILABLE", "CHECKED_INTENT_ONLY", "EXPIRED"]),
    })
    .strict(),
])
const stopResult = z.discriminatedUnion("kind", [
  unknown,
  z
    .object({
      kind: z.literal("committed"),
      operationId: id,
      attemptId: id,
      commandId: id,
      state: z.literal("STOPPING"),
    })
    .strict(),
])
const dispatchResult = z.discriminatedUnion("kind", [
  unknown,
  z.object({ kind: z.literal("idle"), operationId: id, attemptId: id }).strict(),
  z
    .object({
      kind: z.literal("committed"),
      operationId: id,
      attemptId: id,
      state: z.literal("START_PENDING"),
      startId: id,
      commandId: id,
    })
    .strict(),
])
const reconcileResult = z.discriminatedUnion("kind", [
  unknown,
  z
    .object({
      kind: z.literal("committed"),
      operationId: id,
      attemptId: id,
      commandId: id,
      state: z.enum(["UNKNOWN", "STOPPING"]),
    })
    .strict(),
])
const receiptResult = z
  .object({
    operationId: id,
    confirmedSequence: z.number().int().nonnegative().safe(),
    receipts: z.number().int().nonnegative(),
    dispositions: z.array(
      z
        .object({
          commandId: id,
          status: z.enum(["HELD", "UNKNOWN", "PREPARED", "STARTED", "STOPPED", "NEVER_DISPATCHED"]),
          observedStatus: z.string().min(1).max(128),
        })
        .strict()
    ),
  })
  .strict()

/** Use the persisted worker-instance grant credential, never the broker control token. */
export function createWorkerBrokerClient(
  workerCredential: string
): WorkerBrokerInstallation["broker"] {
  if (
    typeof workerCredential !== "string" ||
    workerCredential.length < 32 ||
    workerCredential.length > 1024 ||
    workerCredential.trim() !== workerCredential ||
    /[\r\n]/.test(workerCredential)
  )
    throw new Error("Broker control credential unavailable")

  const call = (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let settled = false
      let size = 0
      const chunks: Buffer[] = []
      const raw = body === undefined ? undefined : JSON.stringify(body)
      const req = request(
        {
          socketPath,
          method,
          path,
          headers: {
            authorization: `Bearer ${workerCredential}`,
            accept: "application/json",
            ...(raw === undefined ? {} : { "content-type": "application/json" }),
          },
        },
        (response) => {
          if (response.statusCode !== 200) return finish(true)
          response.on("data", (part: Buffer) => {
            size += part.length
            if (size > 256 * 1024) return finish(true)
            chunks.push(part)
          })
          response.once("aborted", () => finish(true))
          response.once("error", () => finish(true))
          response.once("end", () => {
            try {
              finish(false, JSON.parse(Buffer.concat(chunks).toString("utf8")))
            } catch {
              finish(true)
            }
          })
        }
      )
      const command =
        method === "POST" &&
        (path === "/operations/prepare" || /\/(dispatch|stop|reconcile)$/.test(path))
      const timer = setTimeout(() => finish(true), command ? 35_000 : 4000)
      function finish(failed: boolean, result?: unknown) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (failed) {
          req.destroy()
          reject(new Error("Broker control unavailable"))
        } else resolve(result)
      }
      req.once("error", () => finish(true))
      req.end(raw)
    })

  return {
    async dispatchPrepared(input) {
      const { operationId, ...body } = attempt.parse(input)
      const result = dispatchResult.parse(
        await call("POST", `/operations/${operationId}/dispatch`, body)
      )
      if (
        result.operationId !== operationId ||
        ("attemptId" in result && result.attemptId !== body.attemptId)
      )
        throw new Error("Broker operation mismatch")
      return result
    },
    async prepare(input) {
      const parsed = prepareInput.parse(input)
      const result = prepareResult.parse(await call("POST", "/operations/prepare", parsed))
      if (result.operationId !== parsed.operationId) throw new Error("Broker operation mismatch")
      return result
    },
    async status(operationId) {
      id.parse(operationId)
      const result = statusResult.parse(await call("GET", `/operations/${operationId}`))
      if (result.operationId !== operationId) throw new Error("Broker operation mismatch")
      return result
    },
    async stop(input) {
      const { operationId, ...body } = stopInput.parse(input)
      const result = stopResult.parse(await call("POST", `/operations/${operationId}/stop`, body))
      if (
        result.operationId !== operationId ||
        (result.kind === "committed" && result.attemptId !== body.attemptId)
      )
        throw new Error("Broker operation mismatch")
      return result
    },
    async reconcile(input) {
      const { operationId, ...body } = attempt.parse(input)
      const result = reconcileResult.parse(
        await call("POST", `/operations/${operationId}/reconcile`, body)
      )
      if (
        result.operationId !== operationId ||
        (result.kind === "committed" && result.attemptId !== body.attemptId)
      )
        throw new Error("Broker operation mismatch")
      return result
    },
    async consumeSupervisorReceipts(operationId) {
      id.parse(operationId)
      const result = receiptResult.parse(await call("POST", `/operations/${operationId}/consume`))
      if (result.operationId !== operationId) throw new Error("Broker operation mismatch")
      return result
    },
  }
}
