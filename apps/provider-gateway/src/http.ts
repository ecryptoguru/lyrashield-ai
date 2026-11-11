import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http"
import { ProviderGatewayError, type ProviderGatewayService } from "./service"
import { httpStreamSink } from "./downstream"

const MAX_REQUEST_BYTES = 4 * 1024 * 1024

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function authorizedControl(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  return (
    typeof header === "string" &&
    header.startsWith("Bearer ") &&
    secureEqual(header.slice(7), token)
  )
}

function authorizedGrant(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > MAX_REQUEST_BYTES)
      throw new ProviderGatewayError("BODY_TOO_LARGE", "request is too large", 413)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request)
  if (body.byteLength === 0)
    throw new ProviderGatewayError("INVALID_JSON", "request body is required", 400)
  try {
    return JSON.parse(body.toString("utf8"))
  } catch {
    throw new ProviderGatewayError("INVALID_JSON", "request body is not valid JSON", 400)
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const raw = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(raw),
    "x-content-type-options": "nosniff",
  })
  response.end(raw)
}

export function createProviderGatewayHandler(
  service: ProviderGatewayService,
  options: { controlToken: string; admission: "closed" | "open" }
): RequestListener {
  if (Buffer.byteLength(options.controlToken, "utf8") < 32) {
    throw new Error("provider gateway control token must be at least 32 bytes")
  }
  return (request, response) => {
    void handleRequest(request, response, service, options).catch((error: unknown) => {
      if (response.headersSent || response.destroyed) {
        response.destroy()
        return
      }
      if (error instanceof ProviderGatewayError) {
        sendJson(response, error.httpStatus, { code: error.code, message: error.message })
        return
      }
      sendJson(response, 502, {
        code: "PROVIDER_GATEWAY_UNAVAILABLE",
        message: "provider gateway failed closed",
      })
    })
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ProviderGatewayService,
  options: { controlToken: string; admission: "closed" | "open" }
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://provider-gateway.invalid")
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok", admission: options.admission })
    return
  }
  const proxyMatch = /^\/v1\/provider\/([a-z][a-z0-9-]{1,63})(\/.*)$/.exec(url.pathname)
  if (request.method === "POST" && proxyMatch?.[1] && proxyMatch[2]) {
    const token = authorizedGrant(request)
    if (!token) {
      sendJson(response, 401, { code: "GRANT_REQUIRED", message: "attempt-bound grant required" })
      return
    }
    const requestId = request.headers["x-lyra-request-id"]
    if (typeof requestId !== "string") {
      sendJson(response, 400, {
        code: "REQUEST_ID_REQUIRED",
        message: "request identity is required",
      })
      return
    }
    const scanId = request.headers["x-lyra-scan-id"]
    if (typeof scanId !== "string" || !scanId) {
      sendJson(response, 400, { code: "SCAN_ID_REQUIRED", message: "scan identity is required" })
      return
    }
    const downstream = new AbortController()
    const disconnected = () => {
      if (!response.writableFinished) downstream.abort()
    }
    response.on("close", disconnected)
    response.on("error", disconnected)
    try {
      const body = await readBody(request)
      const upstream = await service.proxy(
        {
          scanId,
          providerId: proxyMatch[1],
          path: `${proxyMatch[2]}${url.search}`,
          method: request.method,
          authorization: `Bearer ${token}`,
          requestId,
          ...(typeof request.headers["content-type"] === "string"
            ? { contentType: request.headers["content-type"] }
            : {}),
          ...(typeof request.headers.accept === "string" ? { accept: request.headers.accept } : {}),
          body,
        },
        httpStreamSink(response, downstream.signal)
      )
      if (upstream.streamed) return
      response.writeHead(upstream.statusCode, {
        ...upstream.headers,
        "cache-control": "no-store",
        "content-length": upstream.body.byteLength,
        "x-content-type-options": "nosniff",
      })
      response.end(upstream.body)
    } finally {
      response.off("close", disconnected)
      response.off("error", disconnected)
    }
    return
  }
  if (!authorizedControl(request, options.controlToken)) {
    sendJson(response, 401, { code: "UNAUTHORIZED", message: "control credential required" })
    return
  }
  const requestStatusMatch = /^\/v1\/requests\/([A-Za-z0-9._:-]{3,192})$/.exec(url.pathname)
  if (request.method === "GET" && requestStatusMatch?.[1]) {
    const status = await service.inspectRequest(requestStatusMatch[1])
    sendJson(response, status ? 200 : 404, status ?? { code: "REQUEST_NOT_FOUND" })
    return
  }
  if (request.method === "POST" && url.pathname === "/v1/grants") {
    sendJson(response, 200, await service.issueGrant(await readJson(request)))
    return
  }
  const requestGrantMatch = /^\/v1\/grants\/request\/([A-Za-z0-9._:-]{3,192})$/.exec(url.pathname)
  if (request.method === "GET" && requestGrantMatch?.[1]) {
    const grant = await service.findGrantByRequest(requestGrantMatch[1])
    sendJson(response, grant ? 200 : 404, grant ?? { code: "GRANT_NOT_FOUND" })
    return
  }
  const revokeMatch = /^\/v1\/grants\/([A-Za-z0-9._:-]{3,192})\/revoke$/.exec(url.pathname)
  if (request.method === "POST" && revokeMatch?.[1]) {
    const body = await readJson(request)
    if (body === null || typeof body !== "object") {
      throw new ProviderGatewayError("INVALID_JSON", "revocation body must be an object", 400)
    }
    sendJson(
      response,
      200,
      await service.revokeGrant({
        grantId: revokeMatch[1],
        attemptId: Reflect.get(body, "attemptId"),
        reason: Reflect.get(body, "reason"),
      })
    )
    return
  }
  const grantMatch = /^\/v1\/grants\/([A-Za-z0-9._:-]{3,192})$/.exec(url.pathname)
  if (request.method === "GET" && grantMatch?.[1]) {
    const grant = await service.inspectGrant(grantMatch[1])
    sendJson(response, grant ? 200 : 404, grant ?? { code: "GRANT_NOT_FOUND" })
    return
  }
  sendJson(response, 404, { code: "NOT_FOUND", message: "route not found" })
}
