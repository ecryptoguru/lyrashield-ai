/**
 * Headless Myra client — fetch + SSE parsing only. Runs in the Next.js
 * dashboard bundle AND the Astro/Cloudflare marketing island. No Node APIs.
 */
import {
  myraStreamEventSchema,
  type BookingRequest,
  type MyraStreamEvent,
  type MyraSurface,
} from "./contracts"

export interface MyraClientOptions {
  /** Absolute API base, e.g. https://app.lyrashieldai.com (marketing) or "" (same-origin dashboard). */
  apiBase: string
  surface: MyraSurface
  /** Anonymous-session bearer; dashboard requests use cookies instead. */
  getPublicToken?: () => string | null
  /** Route identifier for context-aware starters/answers (allowlisted). */
  routeContext?: string
  /** Anonymous personalization only. Read from sessionStorage by the caller. */
  getSessionMemory?: () => Record<string, string> | null
  fetchImpl?: typeof fetch
}

export interface SendMessageInput {
  text: string
  conversationId?: string
  signal?: AbortSignal
  /** Structured slot-picker submission — drives book_demo without text parsing. */
  bookingRequest?: BookingRequest
}

export class MyraClientError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "MyraClientError"
  }
}

export function createMyraClient(options: MyraClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const credentials = options.surface === "MARKETING" ? "omit" : "include"

  function headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
      ...extra,
    }
    const token = options.getPublicToken?.()
    if (token) h["x-myra-session"] = token
    return h
  }

  async function readError(res: Response): Promise<never> {
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      throw new MyraClientError(
        body.error?.code ?? `HTTP_${res.status}`,
        body.error?.message ?? `Request failed (${res.status})`
      )
    } catch (e) {
      if (e instanceof MyraClientError) throw e
      throw new MyraClientError(`HTTP_${res.status}`, `Request failed (${res.status})`)
    }
  }

  /** Parse an SSE body into validated stream events. Unknown events are dropped. */
  async function* events(res: Response, signal?: AbortSignal): AsyncGenerator<MyraStreamEvent> {
    if (!res.body) throw new MyraClientError("NO_STREAM", "Empty response body")
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let terminal = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"))
          if (!dataLine) continue
          const raw = dataLine.slice(5).trim()
          try {
            const parsed = myraStreamEventSchema.safeParse(JSON.parse(raw))
            if (parsed.success) {
              if (parsed.data.type === "done" || parsed.data.type === "error") terminal = true
              yield parsed.data
            }
          } catch {
            /* malformed event frame — drop */
          }
        }
      }
      if (!terminal && !signal?.aborted) {
        throw new MyraClientError("STREAM_INTERRUPTED", "The response ended before completion.")
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  return {
    /** Send a message and stream validated events until `done`/`error`. */
    async *sendMessage(input: SendMessageInput): AsyncGenerator<MyraStreamEvent> {
      const sessionMemory = options.getSessionMemory?.()
      const res = await fetchImpl(`${options.apiBase}/api/myra/message`, {
        method: "POST",
        credentials,
        signal: input.signal,
        headers: headers(),
        body: JSON.stringify({
          text: input.text,
          conversationId: input.conversationId,
          routeContext: options.routeContext,
          surface: options.surface,
          ...(input.bookingRequest ? { bookingRequest: input.bookingRequest } : {}),
          ...(sessionMemory ? { sessionMemory } : {}),
        }),
      })
      if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
        await readError(res)
      }
      yield* events(res, input.signal)
    },

    /** Type-ahead suggestions — retrieval only, never a model call. */
    async suggest(text: string, signal?: AbortSignal) {
      const res = await fetchImpl(`${options.apiBase}/api/myra/suggest`, {
        method: "POST",
        credentials,
        signal,
        headers: headers({ accept: "application/json" }),
        body: JSON.stringify({
          text,
          surface: options.surface,
          routeContext: options.routeContext,
        }),
      })
      if (!res.ok) await readError(res)
      return (await res.json()) as {
        suggestions: { entryId: string; title: string; snippet: string; sourceUrl?: string }[]
      }
    },

    async confirmProposal(proposalId: string) {
      const res = await fetchImpl(`${options.apiBase}/api/myra/proposals/confirm`, {
        method: "POST",
        credentials,
        headers: headers({ accept: "application/json" }),
        body: JSON.stringify({ proposalId }),
      })
      if (!res.ok) await readError(res)
      return res.json()
    },

    async cancelProposal(proposalId: string) {
      const res = await fetchImpl(`${options.apiBase}/api/myra/proposals/cancel`, {
        method: "POST",
        credentials,
        headers: headers({ accept: "application/json" }),
        body: JSON.stringify({ proposalId }),
      })
      if (!res.ok) await readError(res)
      return res.json()
    },

    async rateAnswer(messageId: string, rating: "helpful" | "not_helpful") {
      const res = await fetchImpl(`${options.apiBase}/api/myra/feedback`, {
        method: "POST",
        credentials,
        headers: headers({ accept: "application/json" }),
        body: JSON.stringify({ messageId, rating }),
      })
      if (!res.ok) await readError(res)
      return res.json()
    },

    async clearMemory() {
      const res = await fetchImpl(`${options.apiBase}/api/myra/memory`, {
        method: "DELETE",
        credentials,
        headers: headers({ accept: "application/json" }),
      })
      if (!res.ok) await readError(res)
      return res.json()
    },

    async listCases() {
      const res = await fetchImpl(`${options.apiBase}/api/myra/cases`, {
        credentials,
        headers: headers({ accept: "application/json" }),
      })
      if (!res.ok) await readError(res)
      return res.json()
    },

    async getCase(id: string) {
      const res = await fetchImpl(`${options.apiBase}/api/myra/cases/${encodeURIComponent(id)}`, {
        credentials,
        headers: headers({ accept: "application/json" }),
      })
      if (!res.ok) await readError(res)
      return res.json()
    },

    async replyToCase(id: string, body: string) {
      const res = await fetchImpl(
        `${options.apiBase}/api/myra/cases/${encodeURIComponent(id)}/replies`,
        {
          method: "POST",
          credentials,
          headers: headers({ accept: "application/json" }),
          body: JSON.stringify({ body }),
        }
      )
      if (!res.ok) await readError(res)
      return res.json()
    },
  }
}

export type MyraClient = ReturnType<typeof createMyraClient>
