import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { z } from "zod"
import { queuePublicationVerificationInputSchema } from "@lyrashield/db/src/scan-queue-publication-verifier-schema"
import { withScanDispatchWorkerCredential } from "@lyrashield/db/src/scan-dispatch-worker-assignment"
import type { BrokerService } from "./service"

const MAX_REQUEST_BYTES = 64 * 1024
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)

const prepareSchema = z
  .object({
    operationId: identity,
    workerInstanceId: identity,
    workerGrantId: identity,
    authorityEpochId: identity,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
const attemptSchema = z
  .object({
    attemptId: identity,
    workerInstanceId: identity,
    workerGrantId: identity,
    authorityEpochId: identity,
  })
  .strict()
const stopSchema = attemptSchema.extend({ reasonCode }).strict()

const ROUTES = [
  { method: "POST", pattern: /^\/operations\/prepare$/, action: "prepare" },
  { method: "POST", pattern: /^\/operations\/([^/]+)\/start-paid$/, action: "startPaid" },
  { method: "POST", pattern: /^\/operations\/([^/]+)\/start-unmetered$/, action: "startUnmetered" },
  { method: "POST", pattern: /^\/operations\/([^/]+)\/stop$/, action: "stop" },
  { method: "POST", pattern: /^\/operations\/([^/]+)\/reconcile$/, action: "reconcile" },
  { method: "POST", pattern: /^\/operations\/([^/]+)\/dispatch$/, action: "dispatch" },
  { method: "POST", pattern: /^\/operations\/([^/]+)\/result$/, action: "result" },
  { method: "POST", pattern: /^\/operations\/([^/]+)\/consume$/, action: "consume" },
  {
    method: "POST",
    pattern: /^\/operations\/([^/]+)\/verify-publication$/,
    action: "verifyPublication",
  },
  { method: "GET", pattern: /^\/operations\/([^/]+)$/, action: "status" },
] as const

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  return (
    typeof header === "string" &&
    header.startsWith("Bearer ") &&
    secureEqual(header.slice(7), token)
  )
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const raw = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(raw),
    "x-content-type-options": "nosniff",
  })
  response.end(raw)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > MAX_REQUEST_BYTES) return undefined
    chunks.push(bytes)
  }
  if (total === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return undefined
  }
}

/** The stored authority raises typed codes; only known ones map to client faults. */
const CLIENT_ERRORS = new Set([
  "OPERATION_NOT_FOUND",
  "DISPATCH_OPERATION_STATE_INVALID",
  "DISPATCH_SCOPE_CHANGED",
  "DISPATCH_REPLAY_CONFLICT",
  "WORKER_GRANT_INVALID",
  "AUTHORITY_EPOCH_CLOSED",
  "CAPACITY_NOT_READY",
  "QUEUE_PUBLICATION_NOT_CONFIRMED",
])

function failure(error: unknown): { status: number; code: string } {
  const code = (error as { code?: unknown } | null)?.code
  const named = typeof code === "string" ? code : "BROKER_REJECTED"
  if (named === "SUPERVISOR_CONSUMER_NOT_INSTALLED") return { status: 503, code: named }
  if (CLIENT_ERRORS.has(named)) return { status: 409, code: named }
  // Expected unavailable-authority conditions: the installation simply is not
  // open (for example PREPARATION_AUTHORITY_CLOSED) or cannot compile the
  // command from installed policy. These are 503, not 500: they describe a
  // closed capability, never an internal fault.
  if (
    named === "ADMISSION_CLOSED" ||
    named === "DATABASE_REJECTED" ||
    named === "PREPARATION_AUTHORITY_BUSY" ||
    named === "PREPARATION_AUTHORITY_UNAVAILABLE" ||
    named === "PREPARATION_AUTHORITY_CLOSED"
  )
    return { status: 503, code: named }
  return { status: 500, code: named }
}

export function createBrokerHandler(service: BrokerService, controlToken: string) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? "").split("?")[0] ?? ""
    // Unauthenticated liveness only: the socket is private and mode 0660, and the
    // sibling controller images expose the same shape.
    if (request.method === "GET" && path === "/healthz")
      return send(response, 200, { status: "ok", admission: service.admission })
    const controlAuthorized = authorized(request, controlToken)
    const header = request.headers.authorization
    const workerCredential =
      !controlAuthorized && typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7)
        : undefined
    if (!controlAuthorized && !workerCredential)
      return send(response, 401, { error: "UNAUTHORIZED" })
    const route = ROUTES.find(
      (candidate) => candidate.method === request.method && candidate.pattern.test(path)
    )
    if (!route) return send(response, 404, { error: "NOT_FOUND" })
    if (!controlAuthorized && (route.action === "startPaid" || route.action === "startUnmetered"))
      return send(response, 403, { error: "CONTROL_AUTHORITY_REQUIRED" })
    if (controlAuthorized && (route.action === "dispatch" || route.action === "result"))
      return send(response, 403, { error: "WORKER_AUTHORITY_REQUIRED" })
    const operationId = route.pattern.exec(path)?.[1]
    if (operationId !== undefined && !identity.safeParse(operationId).success)
      return send(response, 400, { error: "INVALID_OPERATION_ID" })
    const invoke = <T>(
      scope: Parameters<typeof withScanDispatchWorkerCredential>[1],
      action: () => Promise<T>
    ) =>
      controlAuthorized
        ? action()
        : withScanDispatchWorkerCredential(workerCredential!, scope, action)
    try {
      if (route.action === "result") {
        if (!operationId || !service.readResult) return send(response, 404, { error: "NOT_FOUND" })
        const input = z
          .object({
            attemptId: identity,
            offset: z
              .number()
              .int()
              .nonnegative()
              .safe()
              .max(96 * 1024 * 1024),
          })
          .strict()
          .safeParse(await readJson(request))
        if (!input.success) return send(response, 400, { error: "INVALID_REQUEST" })
        return send(
          response,
          200,
          await invoke({ operationId, attemptId: input.data.attemptId }, () =>
            service.readResult!({ operationId, ...input.data })
          )
        )
      }
      if (route.action === "status") {
        if (operationId === undefined) return send(response, 400, { error: "INVALID_OPERATION_ID" })
        return send(response, 200, await invoke({ operationId }, () => service.status(operationId)))
      }
      if (route.action === "consume") {
        if (operationId === undefined) return send(response, 400, { error: "INVALID_OPERATION_ID" })
        return send(
          response,
          200,
          await invoke({ operationId }, () => service.consume(operationId))
        )
      }
      if (route.action === "verifyPublication") {
        if (!operationId || !service.verifyPublication)
          return send(response, 404, { error: "NOT_FOUND" })
        const parsed = queuePublicationVerificationInputSchema.safeParse(await readJson(request))
        if (
          !parsed.success ||
          parsed.data.operationId !== operationId ||
          Buffer.byteLength(JSON.stringify(parsed.data)) > 8192
        )
          return send(response, 400, { error: "INVALID_REQUEST" })
        return send(
          response,
          200,
          await invoke({ operationId }, () => service.verifyPublication!(parsed.data))
        )
      }
      if (route.action === "prepare") {
        const parsed = prepareSchema.safeParse(await readJson(request))
        if (!parsed.success) return send(response, 400, { error: "INVALID_REQUEST" })
        const expiresAt = new Date(parsed.data.expiresAt)
        if (Number.isNaN(expiresAt.getTime()))
          return send(response, 400, { error: "INVALID_REQUEST" })
        const { operationId: bodyId, ...rest } = parsed.data
        return send(
          response,
          200,
          await invoke(
            {
              operationId: bodyId,
              workerGrantId: rest.workerGrantId,
              workerInstanceId: rest.workerInstanceId,
              authorityEpochId: rest.authorityEpochId,
            },
            () => service.prepare({ ...rest, operationId: bodyId, expiresAt })
          )
        )
      }
      // Every remaining route carries its operation in the path.
      if (!operationId) return send(response, 400, { error: "INVALID_OPERATION_ID" })
      if (route.action === "stop") {
        const parsed = stopSchema.safeParse(await readJson(request))
        if (!parsed.success) return send(response, 400, { error: "INVALID_REQUEST" })
        const scope = {
          attemptId: parsed.data.attemptId,
          workerGrantId: parsed.data.workerGrantId,
          workerInstanceId: parsed.data.workerInstanceId,
          authorityEpochId: parsed.data.authorityEpochId,
        }
        return send(
          response,
          200,
          await invoke({ ...scope, operationId }, () =>
            service.stop({ ...parsed.data, operationId })
          )
        )
      }
      const parsed = attemptSchema.safeParse(await readJson(request))
      if (!parsed.success) return send(response, 400, { error: "INVALID_REQUEST" })
      const input = { ...parsed.data, operationId }
      if (route.action === "dispatch") {
        if (!service.dispatchPrepared) return send(response, 404, { error: "NOT_FOUND" })
        return send(response, 200, await invoke(input, () => service.dispatchPrepared!(input)))
      }
      if (route.action === "startPaid") return send(response, 200, await service.startPaid(input))
      if (route.action === "startUnmetered")
        return send(response, 200, await service.startUnmetered(input))
      return send(response, 200, await invoke(input, () => service.reconcile(input)))
    } catch (error) {
      if (!controlAuthorized && (error as { code?: string })?.code === "WORKER_GRANT_INVALID")
        return send(response, 401, { error: "UNAUTHORIZED" })
      const mapped = failure(error)
      return send(response, mapped.status, { error: mapped.code })
    }
  }
}
