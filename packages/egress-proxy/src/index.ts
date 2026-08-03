import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { logger } from "@lyrashield/logger"
import { redactUrlForLogs, safeFetchOnce, type SafeFetchOutcome } from "@lyrashield/security"

const FetchRequestSchema = z
  .object({
    url: z.string().url(),
    userAgent: z.string().optional(),
    timeoutMs: z.coerce.number().int().positive().optional(),
    maxBytes: z.coerce.number().int().positive().optional(),
  })
  .strict()

export interface ProxyServer {
  port: number
  ready: Promise<void>
  close(): Promise<void>
}

export interface ProxyOptions {
  token: string
  port?: number
}

function isAuthorized(
  requestHeaders: Record<string, string | string[] | undefined>,
  secret: string
): boolean {
  const auth = requestHeaders["authorization"]
  const expected = `Bearer ${secret}`
  if (Array.isArray(auth)) {
    return auth.some((value) => value === expected)
  }
  return auth === expected
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  })
  response.end(payload)
}

async function handleFetch(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, reason: "invalid_response", detail: "Method not allowed" })
    return
  }

  if (!isAuthorized(request.headers, secret)) {
    logger.warn("Egress proxy request missing or invalid authorization")
    sendJson(response, 401, { ok: false, reason: "request_failed", detail: "Unauthorized" })
    return
  }

  let body: unknown
  try {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk))
      // Reject bodies larger than a few KB; the proxy only accepts a small JSON payload.
      const total = chunks.reduce((sum, c) => sum + c.length, 0)
      if (total > 8192) {
        sendJson(response, 413, {
          ok: false,
          reason: "body_read_failed",
          detail: "Request body too large",
        })
        return
      }
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    sendJson(response, 400, { ok: false, reason: "invalid_response", detail })
    return
  }

  const parsed = FetchRequestSchema.safeParse(body)
  if (!parsed.success) {
    sendJson(response, 400, {
      ok: false,
      reason: "invalid_response",
      detail: parsed.error.issues.map((issue) => issue.message).join(", "),
    })
    return
  }

  const { url, userAgent, timeoutMs, maxBytes } = parsed.data
  const target = redactUrlForLogs(url)
  logger.info("Egress proxy fetch", { url: target })

  const controller = new AbortController()
  const onRequestClose = () => controller.abort()
  request.on("close", onRequestClose)
  request.on("error", onRequestClose)

  const outcome = await safeFetchOnce(url, {
    userAgent,
    timeoutMs,
    maxBytes,
    signal: controller.signal,
  })

  request.off("close", onRequestClose)
  request.off("error", onRequestClose)

  if (!outcome.ok) {
    logger.warn("Egress proxy fetch failed", {
      url: target,
      reason: outcome.reason,
      detail: outcome.detail,
    })
    sendJson(response, 200, outcome)
    return
  }

  logger.info("Egress proxy fetch complete", {
    url: target,
    status: outcome.result.status,
    bytes: Buffer.byteLength(outcome.result.html, "utf8"),
  })

  // The worker already checks every redirect, so return the raw (possibly 3xx)
  // response and let the worker decide the next hop.
  sendJson(response, 200, outcome)
}

export function startProxy(options: ProxyOptions): ProxyServer {
  const { token, port = 4000 } = options

  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "text/plain" })
      response.end("ok")
      return
    }
    if (request.url === "/fetch" || request.url === "/v1/fetch") {
      void handleFetch(request, response, token).catch((err) => {
        const detail = err instanceof Error ? err.message : String(err)
        logger.error("Unhandled egress proxy error", { error: detail })
        sendJson(response, 500, {
          ok: false,
          reason: "request_failed",
          detail,
        } as SafeFetchOutcome)
      })
      return
    }
    sendJson(response, 404, {
      ok: false,
      reason: "request_failed",
      detail: "Not found",
    })
  })

  let resolveReady: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  server.listen(port, () => {
    logger.info("LyraShield egress proxy listening", {
      port: (server.address() as { port: number }).port,
    })
    resolveReady()
  })

  process.on("SIGTERM", () => {
    server.close(() => {
      process.exit(0)
    })
  })

  return {
    get port() {
      return (server.address() as { port: number } | null)?.port ?? port
    },
    ready,
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    },
  }
}

function main() {
  const token = process.env.LYRASHIELD_EGRESS_PROXY_SECRET
  if (!token) {
    logger.error("LYRASHIELD_EGRESS_PROXY_SECRET is required")
    process.exit(1)
  }
  const port = Number(process.env.PORT || 4000)
  startProxy({ token, port })
}

const entryFile = process.argv[1] ? pathToFileURL(process.argv[1]).href : ""
if (import.meta.url === entryFile) {
  main()
}
