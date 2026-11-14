import type { IncomingMessage, ServerResponse } from "node:http"
import { z } from "zod"
import { canonicalJson, sandboxToolRequestSchema } from "@lyrashield/runtime-control"
import { sandboxToolResponseBindingSchema } from "./sandbox-tool-response"
import type { createSandboxToolRunner } from "./sandbox-tool-runner"

const bounds = {
  yieldTimeSeconds: z.number().min(0).max(30),
  maxOutputTokens: z.number().int().min(1).max(100000),
}
const startSchema = sandboxToolRequestSchema.safeExtend({ ...bounds, tty: z.boolean() })
const mutationBase = {
  binding: sandboxToolResponseBindingSchema,
  requestId: z.string().uuid(),
  commandId: z
    .string()
    .min(3)
    .max(192)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}
const stdinSchema = z
  .object({
    ...mutationBase,
    ...bounds,
    sessionId: z.number().int().positive().safe(),
    outputCursor: z.number().int().nonnegative().safe(),
    chars: z.string().refine((value) => Buffer.byteLength(value) <= 65536),
  })
  .strict()
const terminateSchema = z.object(mutationBase).strict()

function uniqueHeader(request: IncomingMessage, name: string) {
  const values = request.rawHeaders.flatMap((value, index) =>
    index % 2 === 0 && value.toLowerCase() === name ? [request.rawHeaders[index + 1]] : []
  )
  return values.length === 1 ? values[0] : undefined
}
function send(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  })
  response.end(body)
}
async function body(request: IncomingMessage) {
  let bytes = Buffer.alloc(0)
  for await (const chunk of request) {
    bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    if (bytes.length > 128 * 1024) throw new Error("PTY input exceeds its bound")
  }
  return JSON.parse(bytes.toString("utf8")) as unknown
}

/** The existing scoped tool runner owns intent, native fence, encrypted response and ACK. */
export function createSandboxToolPtyHandler(
  tools: ReturnType<typeof createSandboxToolRunner>,
  fallback: (request: IncomingMessage, response: ServerResponse) => Promise<void>
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "", "http://supervisor.invalid")
    const route =
      /^\/v1\/sandbox\/([A-Za-z0-9._:-]{3,192})\/pty\/(start|stdin|terminate|[1-9][0-9]*)$/.exec(
        url.pathname
      )
    if (!route) return fallback(request, response)
    try {
      const authorization = uniqueHeader(request, "authorization"),
        sandboxHandle = uniqueHeader(request, "x-lyrashield-sandbox-handle")
      if (
        !authorization?.startsWith("Bearer ") ||
        authorization.length < 39 ||
        authorization.length > 2055 ||
        !sandboxHandle
      ) {
        send(response, 401, { code: "SANDBOX_AUTH_REQUIRED" })
        return
      }
      const credential = { token: authorization.slice(7), attemptId: route[1]!, sandboxHandle }
      if (request.method === "GET" && /^[1-9][0-9]*$/.test(route[2]!)) {
        const entries = [...url.searchParams]
        if (
          entries.length !== 3 ||
          new Set(entries.map(([name]) => name)).size !== 3 ||
          entries.some(
            ([name]) => !["outputCursor", "yieldTimeSeconds", "maxOutputTokens"].includes(name)
          )
        )
          throw new Error()
        const parsed = z
          .object({ outputCursor: z.number().int().nonnegative().safe(), ...bounds })
          .strict()
          .parse({
            outputCursor: Number(url.searchParams.get("outputCursor")),
            yieldTimeSeconds: Number(url.searchParams.get("yieldTimeSeconds")),
            maxOutputTokens: Number(url.searchParams.get("maxOutputTokens")),
          })
        const sessionId = z.number().int().positive().safe().parse(Number(route[2]))
        send(
          response,
          200,
          await tools.operations.readPty(credential, {
            sessionId,
            outputCursor: parsed.outputCursor,
            maxOutputBytes: Math.min(1024 * 1024, parsed.maxOutputTokens * 4),
            yieldTimeSeconds: parsed.yieldTimeSeconds,
          })
        )
        return
      }
      if (request.method !== "POST" || url.search) throw new Error()
      const input = await body(request)
      const parsed =
        route[2] === "start"
          ? startSchema.parse(input)
          : route[2] === "stdin"
            ? stdinSchema.parse(input)
            : terminateSchema.parse(input)
      if (
        parsed.binding.attemptId !== credential.attemptId ||
        parsed.binding.sandboxHandle !== sandboxHandle
      )
        throw new Error()
      const result = await tools.authority.run(credential, async (installed) => {
        if (
          canonicalJson(sandboxToolResponseBindingSchema.parse(installed)) !==
          canonicalJson(parsed.binding)
        )
          throw new Error()
        if (route[2] === "start") {
          const { tty, yieldTimeSeconds, maxOutputTokens, ...exec } = startSchema.parse(parsed)
          return tools.operations.executePty(credential, sandboxToolRequestSchema.parse(exec), {
            tty,
            yieldTimeSeconds,
            maxOutputTokens,
          })
        }
        const command = {
          binding: parsed.binding,
          requestId: parsed.requestId,
          commandId: parsed.commandId,
          cwd: "/workspace",
          user: "pentester" as const,
          timeoutSeconds: 2,
          maxOutputBytes: 1024 * 1024,
        }
        if (route[2] === "stdin") {
          const value = stdinSchema.parse(parsed)
          return tools.operations.executeMutation(credential, command, "pty/stdin", {
            sessionId: value.sessionId,
            chars: value.chars,
            outputCursor: value.outputCursor,
            yieldTimeSeconds: value.yieldTimeSeconds,
            maxOutputTokens: value.maxOutputTokens,
          })
        }
        return tools.operations.executeMutation(credential, command, "pty/terminate", {})
      })
      send(response, 200, result)
    } catch {
      send(response, 503, { code: "SANDBOX_TOOL_UNAVAILABLE" })
    }
  }
}
