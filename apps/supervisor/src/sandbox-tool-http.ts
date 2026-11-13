import type { IncomingMessage, ServerResponse } from "node:http"
import { z } from "zod"
import { SandboxToolAcknowledgements } from "./sandbox-tool-ack"
import {
  sandboxToolResponseBindingSchema,
  type SandboxToolResponseBinding,
} from "./sandbox-tool-response"

const ackSchema = z
  .object({
    binding: sandboxToolResponseBindingSchema,
    requestId: z.string().uuid(),
    responseChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()

// This is installed only by the protected host composition. It must resolve the
// scan-bound bearer, verify the exact installed attempt and hold its current
// authority while callback runs; it must never trust request fields as policy.
export interface SandboxToolRequestAuthority {
  run<T>(
    credential: { token: string; attemptId: string; sandboxHandle: string },
    action: (installed: SandboxToolResponseBinding) => Promise<T>
  ): Promise<T>
}

function uniqueHeader(request: IncomingMessage, name: string): string | undefined {
  const values = request.rawHeaders.flatMap((value, index) =>
    index % 2 === 0 && value.toLowerCase() === name ? [request.rawHeaders[index + 1]] : []
  )
  return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  })
  response.end(body)
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const part of request) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part)
    length += bytes.byteLength
    if (length > 16 * 1024) throw new Error("tool acknowledgement too large")
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
}

/** Only receipt ACK is implemented; all other tool routes remain closed. */
export function createSandboxToolAckHandler(
  authority: SandboxToolRequestAuthority,
  acknowledgements: SandboxToolAcknowledgements
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? "", "http://supervisor.invalid")
      const matched =
        /^\/v1\/sandbox\/([A-Za-z0-9._:-]{3,192})\/request\/([0-9a-f-]{36})\/ack$/.exec(
          url.pathname
        )
      if (request.method !== "POST" || !matched?.[1] || !matched[2] || url.search) {
        send(response, 503, { code: "SANDBOX_TOOL_UNAVAILABLE" })
        return
      }
      const authorization = uniqueHeader(request, "authorization")
      const sandboxHandle = uniqueHeader(request, "x-lyrashield-sandbox-handle")
      if (
        !authorization?.startsWith("Bearer ") ||
        authorization.length < 39 ||
        authorization.length > 1024 ||
        !sandboxHandle
      ) {
        send(response, 401, { code: "SANDBOX_AUTH_REQUIRED" })
        return
      }
      const parsed = ackSchema.parse(await body(request))
      if (
        parsed.binding.attemptId !== matched[1] ||
        parsed.requestId !== matched[2] ||
        parsed.binding.sandboxHandle !== sandboxHandle
      )
        throw new Error("sandbox request mismatch")
      const acknowledged = await authority.run(
        { token: authorization.slice(7), attemptId: matched[1], sandboxHandle },
        async (installed) => {
          const bound = sandboxToolResponseBindingSchema.parse(installed)
          if (JSON.stringify(bound) !== JSON.stringify(parsed.binding))
            throw new Error("sandbox authority changed")
          return acknowledgements.acknowledge(bound, parsed.requestId, parsed.responseChecksum)
        }
      )
      send(response, 200, acknowledged)
    } catch {
      send(response, 503, { code: "SANDBOX_TOOL_UNAVAILABLE" })
    }
  }
}
