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
  options: { controlToken: string; admission: "closed" | "open" }
): RequestListener {
  if (Buffer.byteLength(options.controlToken, "utf8") < 32) {
    throw new Error("supervisor control token must be at least 32 bytes")
  }
  return (request, response) => {
    void handleRequest(request, response, service, options).catch((error: unknown) => {
      if (error instanceof RuntimeControlError) {
        sendJson(response, error.httpStatus, { code: error.code, message: error.message })
        return
      }
      if (
        error instanceof IndependentAuthorityError &&
        (error.code === "INVALID_CURSOR" || error.code === "CURSOR_CONFLICT")
      ) {
        sendJson(response, error.code === "INVALID_CURSOR" ? 400 : 409, {
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
  options: { controlToken: string; admission: "closed" | "open" }
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://supervisor.invalid")
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok", admission: options.admission })
    return
  }
  if (!authorized(request, options.controlToken)) {
    sendJson(response, 401, { code: "UNAUTHORIZED", message: "control credential required" })
    return
  }
  if (request.method === "POST" && url.pathname === "/v1/commands") {
    const command = await readJson(request)
    sendJson(response, 200, await service.execute(command))
    return
  }
  if (request.method === "GET" && url.pathname === "/v1/journal") {
    const fields = ["epochId", "supervisorInstanceId", "afterSequence", "afterHash", "limit"]
    if (
      url.searchParams.size !== fields.length ||
      fields.some((field) => url.searchParams.getAll(field).length !== 1) ||
      !/^(0|[1-9][0-9]*)$/.test(url.searchParams.get("afterSequence") ?? "") ||
      !/^[1-9][0-9]*$/.test(url.searchParams.get("limit") ?? "")
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
