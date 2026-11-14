import { z } from "zod"
import type { RequestPolicy } from "./request-policy"
import { costMicros } from "./request-policy"
import { ProviderGatewayError } from "./errors"
import { parseStrictJson } from "./strict-json"

const tokenCount = z.number().int().nonnegative().max(1_000_000)
const responseIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0)
export const terminalUsageSchema = z
  .object({
    version: z.literal(1),
    providerResponseId: responseIdentifierSchema,
    model: z.string().min(1).max(128),
    inputTokens: tokenCount,
    cachedInputTokens: tokenCount,
    outputTokens: tokenCount,
    costMicros: z.number().int().nonnegative().safe(),
    policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type TerminalUsage = z.infer<typeof terminalUsageSchema>

const responseSchema = z
  .object({
    id: responseIdentifierSchema,
    model: z.string().min(1).max(128),
    status: z.literal("completed"),
    error: z.null().optional(),
    incomplete_details: z.null().optional(),
    usage: z
      .object({
        input_tokens: tokenCount,
        output_tokens: tokenCount,
        total_tokens: tokenCount,
        input_tokens_details: z.object({ cached_tokens: tokenCount }).strict(),
        output_tokens_details: z.object({ reasoning_tokens: tokenCount }).strict().optional(),
      })
      .strict(),
  })
  .passthrough()

function invalid(): never {
  throw new ProviderGatewayError(
    "PROVIDER_USAGE_UNKNOWN",
    "terminal provider usage is unavailable or invalid",
    502
  )
}

export class ResponsesUsageParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true })
  private pending = ""
  private terminal: TerminalUsage | undefined
  private responseId: string | undefined
  private done = false

  constructor(
    private readonly policy: RequestPolicy,
    private readonly expected: {
      model: string
      maxOutputTokens: number
      stream: boolean
      policyDigest: string
    }
  ) {}

  get hasTerminal(): boolean {
    return this.terminal !== undefined
  }

  push(chunk: Uint8Array): void {
    try {
      this.pending += this.decoder.decode(chunk, { stream: true })
    } catch {
      invalid()
    }
    if (!this.expected.stream) return
    // The SDK recognizes bare CR as an SSE delimiter. Reject it before that
    // byte can reach the client; a trailing CR may be the first half of CRLF.
    if (/\r(?!\n|$)/.test(this.pending)) invalid()
    // Process complete SSE frames while retaining only a bounded fragment.
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending)
      if (!match || match.index === undefined) break
      const frame = this.pending.slice(0, match.index)
      this.pending = this.pending.slice(match.index + match[0].length)
      this.frame(frame)
    }
    if (Buffer.byteLength(this.pending) > 256 * 1024) invalid()
  }

  finish(): TerminalUsage {
    try {
      this.pending += this.decoder.decode()
    } catch {
      invalid()
    }
    if (this.expected.stream) {
      // Unterminated data frames and extra post-terminal content are partial.
      if (this.pending.trim()) invalid()
    } else {
      this.terminal = this.parseResponse(this.parseJson(this.pending))
    }
    if (!this.terminal) invalid()
    return this.terminal
  }

  private parseJson(value: string): unknown {
    try {
      return parseStrictJson(Buffer.from(value, "utf8"))
    } catch {
      return invalid()
    }
  }

  private frame(frame: string): void {
    if (Buffer.byteLength(frame) > 256 * 1024) invalid()
    const lines = frame.split(/\r?\n/)
    const eventNames = lines
      .filter((line) => line.startsWith("event:"))
      .map((line) => line.slice(6).trim())
    if (eventNames.length > 1) invalid()
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data) return
    if (data === "[DONE]") {
      if (!this.terminal || this.done) invalid()
      this.done = true
      return
    }
    if (this.terminal || this.done) invalid()
    const parsed = this.parseJson(data)
    if (!parsed || typeof parsed !== "object") invalid()
    const type = Reflect.get(parsed, "type")
    if (
      typeof type !== "string" ||
      !type.startsWith("response.") ||
      (eventNames[0] && eventNames[0] !== type)
    )
      invalid()
    if (["response.failed", "response.incomplete", "response.error"].includes(type)) invalid()
    const response = Reflect.get(parsed, "response")
    if (response && typeof response === "object") {
      const parsedId = responseIdentifierSchema.safeParse(Reflect.get(response, "id"))
      if (!parsedId.success) invalid()
      const id = parsedId.data
      const model = Reflect.get(response, "model")
      if (
        (this.responseId !== undefined && this.responseId !== id) ||
        (model !== undefined && model !== this.expected.model)
      )
        invalid()
      this.responseId = id
    }
    const responseId = Reflect.get(parsed, "response_id")
    if (responseId !== undefined) {
      const parsedId = responseIdentifierSchema.safeParse(responseId)
      if (!parsedId.success || (this.responseId !== undefined && this.responseId !== parsedId.data))
        invalid()
      this.responseId = parsedId.data
    }
    if (type === "response.completed") this.terminal = this.parseResponse(response)
  }

  private parseResponse(value: unknown): TerminalUsage {
    const parsed = responseSchema.safeParse(value)
    if (!parsed.success) invalid()
    const response = parsed.data
    const usage = response.usage
    if (
      response.model !== this.expected.model ||
      (this.responseId !== undefined && response.id !== this.responseId) ||
      usage.total_tokens !== usage.input_tokens + usage.output_tokens ||
      usage.input_tokens_details.cached_tokens > usage.input_tokens ||
      (usage.output_tokens_details?.reasoning_tokens ?? 0) > usage.output_tokens ||
      usage.input_tokens > this.policy.maxInputTokens ||
      usage.output_tokens > this.expected.maxOutputTokens
    )
      invalid()
    return terminalUsageSchema.parse({
      version: 1,
      providerResponseId: response.id,
      model: response.model,
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.input_tokens_details.cached_tokens,
      outputTokens: usage.output_tokens,
      costMicros: costMicros(
        this.policy,
        response.model,
        usage.input_tokens,
        usage.input_tokens_details.cached_tokens,
        usage.output_tokens
      ),
      policyDigest: this.expected.policyDigest,
    })
  }
}
