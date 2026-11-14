import { ScanDispatchAuthorityError } from "@lyrashield/db/src/scan-dispatch-authority-error"
import { z } from "zod"
import { withScanDispatchWorkerCredential } from "@lyrashield/db/src/scan-dispatch-worker-assignment"
import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http"
import { IndependentAuthorityError } from "@lyrashield/runtime-control"
import { RuntimeControlError, type SupervisorService } from "./service"

const MAX_REQUEST_BYTES = 1024 * 1024

function secureTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > MAX_REQUEST_BYTES)
      throw new RuntimeControlError("BODY_TOO_LARGE", "request body is too large", 413)
    chunks.push(bytes)
  }
  if (total === 0) throw new RuntimeControlError("INVALID_JSON", "request body is required", 400)
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new RuntimeControlError("INVALID_JSON", "request body is not valid JSON", 400)
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  })
  response.end(body)
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false
  return secureTokenEqual(header.slice("Bearer ".length), expectedToken)
}

export function createSupervisorHandler(
  service: SupervisorService,
  options: {
    controlToken: string
    scopedControlToken?: string
    admission: "closed" | "open"
    sandboxToolHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
    attemptProofIssuer?: (input: unknown) => Promise<unknown>
    receiptConsumer?: (operationId: string) => Promise<unknown>
    nativeResultReader?: (input: unknown) => Promise<unknown>
    persistedCommandReader?: (input: unknown) => Promise<unknown>
  }
): RequestListener {
  if (Buffer.byteLength(options.controlToken, "utf8") < 32) {
    throw new Error("supervisor control token must be at least 32 bytes")
  }
  if (
    options.scopedControlToken &&
    (Buffer.byteLength(options.scopedControlToken) < 32 ||
      options.scopedControlToken === options.controlToken ||
      /[\r\n]/.test(options.scopedControlToken))
  )
    throw new Error("scoped supervisor control token must be distinct and at least 32 bytes")
  return (request, response) => {
    void handleRequest(request, response, service, options).catch((error: unknown) => {
      if (error instanceof ScanDispatchAuthorityError && error.code === "WORKER_GRANT_INVALID") {
        sendJson(response, 403, {
          code: "WORKER_GRANT_INVALID",
          message: "Worker authority is unavailable",
        })
        return
      }
      if (error instanceof RuntimeControlError) {
        sendJson(response, error.httpStatus, { code: error.code, message: error.message })
        return
      }
      if (
        error instanceof IndependentAuthorityError &&
        ["INVALID_CURSOR", "CURSOR_CONFLICT", "INVALID_RECOVERY", "RECOVERY_CONFLICT"].includes(
          error.code
        )
      ) {
        sendJson(response, error.code.startsWith("INVALID_") ? 400 : 409, {
          code: error.code,
          message: error.message,
        })
        return
      }
      sendJson(response, 503, {
        code: "RUNTIME_CONTROL_UNAVAILABLE",
        message: "runtime control failed closed",
      })
    })
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: SupervisorService,
  options: {
    controlToken: string
    scopedControlToken?: string
    admission: "closed" | "open"
    sandboxToolHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
    attemptProofIssuer?: (input: unknown) => Promise<unknown>
    receiptConsumer?: (operationId: string) => Promise<unknown>
    nativeResultReader?: (input: unknown) => Promise<unknown>
    persistedCommandReader?: (input: unknown) => Promise<unknown>
  }
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://supervisor.invalid")
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok", admission: options.admission })
    return
  }
  if (url.pathname.startsWith("/v1/sandbox/")) {
    if (!options.sandboxToolHandler) {
      sendJson(response, 503, { code: "SANDBOX_TOOL_UNAVAILABLE" })
      return
    }
    await options.sandboxToolHandler(request, response)
    return
  }
  const scopedRoute =
    request.method === "POST" &&
    ["/v1/attempt-proof", "/v1/consume-receipts", "/v1/result", "/v1/commands"].includes(
      url.pathname
    )
  if (
    !authorized(request, options.controlToken) &&
    !(scopedRoute && options.scopedControlToken && authorized(request, options.scopedControlToken))
  ) {
    sendJson(response, 401, { code: "UNAUTHORIZED", message: "control credential required" })
    return
  }
  if (request.method === "POST" && url.pathname === "/v1/commands") {
    const value = await readJson(request)
    if (
      !authorized(request, options.controlToken) ||
      (value && typeof value === "object" && "operationId" in value)
    ) {
      const parsed = z
        .object({
          operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/),
          commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/),
          workerCredential: z
            .string()
            .min(32)
            .max(1024)
            .refine((value) => value.trim() === value && !/[\r\n]/.test(value))
            .optional(),
        })
        .strict()
        .safeParse(value)
      if (!parsed.success)
        throw new RuntimeControlError(
          "INVALID_COMMAND_DELIVERY",
          "Persisted command scope is invalid",
          authorized(request, options.controlToken) ? 400 : 401
        )
      if (!options.persistedCommandReader || url.searchParams.size)
        throw new RuntimeControlError(
          "COMMAND_DELIVERY_UNAVAILABLE",
          "Persisted command delivery is unavailable",
          503
        )
      const { workerCredential, ...input } = parsed.data
      const deliver = async () => service.execute(await options.persistedCommandReader!(input))
      const result = workerCredential
        ? await withScanDispatchWorkerCredential(
            workerCredential,
            { operationId: input.operationId },
            deliver
          )
        : await deliver()
      sendJson(response, 200, result)
    } else sendJson(response, 200, await service.execute(value))
    return
  }
  if (request.method === "POST" && url.pathname === "/v1/consume-receipts") {
    if (!options.receiptConsumer || url.searchParams.size)
      throw new RuntimeControlError(
        "RECEIPT_CONSUMER_UNAVAILABLE",
        "Receipt consumption is unavailable",
        503
      )
    const parsed = z
      .object({
        operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/),
        workerCredential: z
          .string()
          .min(32)
          .max(1024)
          .refine((value) => value.trim() === value && !/[\r\n]/.test(value))
          .optional(),
      })
      .strict()
      .safeParse(await readJson(request))
    if (!parsed.success)
      throw new RuntimeControlError(
        "INVALID_RECEIPT_CONSUMPTION",
        "Receipt consumption scope is invalid",
        400
      )
    const input = parsed.data
    const consume = () => options.receiptConsumer!(input.operationId)
    const result = input.workerCredential
      ? await withScanDispatchWorkerCredential(
          input.workerCredential,
          { operationId: input.operationId },
          consume
        )
      : await consume()
    sendJson(response, 200, result)
    return
  }
  if (request.method === "POST" && url.pathname === "/v1/result") {
    if (!options.nativeResultReader || url.searchParams.size)
      throw new RuntimeControlError(
        "ENGINE_RESULT_UNAVAILABLE",
        "Engine result is unavailable",
        503
      )
    const input = z
      .object({
        operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/),
        attemptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/),
        offset: z
          .number()
          .int()
          .nonnegative()
          .safe()
          .max(96 * 1024 * 1024),
        workerCredential: z
          .string()
          .min(32)
          .max(1024)
          .refine((value) => value.trim() === value && !/[\r\n]/.test(value)),
      })
      .strict()
      .safeParse(await readJson(request))
    if (!input.success)
      throw new RuntimeControlError("INVALID_ENGINE_RESULT", "Engine result scope is invalid", 400)
    const { workerCredential, ...scope } = input.data
    sendJson(
      response,
      200,
      await withScanDispatchWorkerCredential(
        workerCredential,
        { operationId: scope.operationId, attemptId: scope.attemptId },
        () => options.nativeResultReader!(scope)
      )
    )
    return
  }
  if (request.method === "POST" && url.pathname === "/v1/attempt-proof") {
    if (!options.attemptProofIssuer || url.searchParams.size)
      throw new RuntimeControlError(
        "ATTEMPT_PROOF_UNAVAILABLE",
        "Attempt proof is unavailable",
        503
      )
    sendJson(response, 200, await options.attemptProofIssuer(await readJson(request)))
    return
  }
  if (request.method === "POST" && url.pathname === "/v1/recovery") {
    if (url.searchParams.size)
      throw new RuntimeControlError(
        "INVALID_RECOVERY",
        "recovery query parameters are not allowed",
        400
      )
    sendJson(response, 200, await service.recover(await readJson(request)))
    return
  }
  if (request.method === "GET" && url.pathname === "/v1/journal") {
    const fields = ["epochId", "supervisorInstanceId", "afterSequence", "afterHash", "limit"]
    const hasSnapshot =
      url.searchParams.has("snapshotSequence") || url.searchParams.has("snapshotHash")
    if (hasSnapshot) fields.push("snapshotSequence", "snapshotHash")
    if (
      url.searchParams.size !== fields.length ||
      fields.some((field) => url.searchParams.getAll(field).length !== 1) ||
      !/^(0|[1-9][0-9]*)$/.test(url.searchParams.get("afterSequence") ?? "") ||
      !/^[1-9][0-9]*$/.test(url.searchParams.get("limit") ?? "") ||
      (hasSnapshot &&
        (!/^(0|[1-9][0-9]*)$/.test(url.searchParams.get("snapshotSequence") ?? "") ||
          !/^[a-f0-9]{64}$/.test(url.searchParams.get("snapshotHash") ?? "")))
    ) {
      throw new RuntimeControlError("INVALID_CURSOR", "invalid supervisor journal cursor", 400)
    }
    sendJson(
      response,
      200,
      await service.readJournal({
        ...Object.fromEntries(url.searchParams),
        afterSequence: Number(url.searchParams.get("afterSequence")),
        limit: Number(url.searchParams.get("limit")),
        ...(hasSnapshot
          ? { snapshotSequence: Number(url.searchParams.get("snapshotSequence")) }
          : {}),
      })
    )
    return
  }
  if (request.method === "GET" && url.pathname === "/v1/resources") {
    const scanId = url.searchParams.get("scanId") ?? undefined
    sendJson(response, 200, { resources: await service.listOwnedContainers(scanId) })
    return
  }
  const attemptMatch = /^\/v1\/attempts\/([A-Za-z0-9._:-]{3,192})$/.exec(url.pathname)
  if (request.method === "GET" && attemptMatch?.[1]) {
    sendJson(response, 200, await service.getAttempt(attemptMatch[1]))
    return
  }
  sendJson(response, 404, { code: "NOT_FOUND", message: "route not found" })
}
