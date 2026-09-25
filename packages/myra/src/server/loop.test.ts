import "./test-env"
import { describe, expect, it, vi } from "vitest"
import type { MyraPrincipal, MyraStreamEvent } from "../contracts"
import { runTaskLoop } from "./loop"
import { MockProvider } from "./provider"
import type { MyraToolContext } from "./tools/types"

/**
 * Item 1.5 — a structured `bookingRequest` (slot click) must reach the
 * book_demo proposal path without relying on natural-language parsing. The
 * regex fallback stays for plain text.
 */

/** Next weekday at 16:00 IST — on-grid and ≥24h out. */
function nextOnGridSlotIso(): string {
  const d = new Date(Date.now() + 72 * 3_600_000)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
  return `${d.toISOString().slice(0, 10)}T16:00:00+05:30`
}

/**
 * Render an instant as `YYYY-MM-DDTHH:MM` in the machine's local zone — the
 * exact fragment the regex path re-parses, so the fallback test is
 * deterministic on any host timezone.
 */
function localIsoMinute(instant: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`
}

function fakeDb(opts: { userEmail?: string; verifiedEmail?: string } = {}) {
  const ops: Record<string, unknown>[] = []
  const db = {
    myraAuditEvent: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
    myraOperation: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `op_${ops.length + 1}`, ...data }
        ops.push(row)
        return row
      },
    },
    user: {
      findUnique: async () => (opts.userEmail ? { email: opts.userEmail } : null),
    },
    myraIdentityVerification: {
      findFirst: async () =>
        opts.verifiedEmail ? { publicSessionId: null, consumedAt: new Date() } : null,
    },
    myraFlowSession: { findFirst: async () => null },
    myraConversation: { findUnique: async () => null },
    demoBooking: { findFirst: async () => null, findMany: async () => [] },
  }
  return { db, ops }
}

function toolCtx(principal: MyraPrincipal, db: unknown): MyraToolContext {
  return {
    principal,
    surface: principal.kind === "user" ? "DASHBOARD" : "MARKETING",
    conversationId: null,
    workspaceId: principal.kind === "user" ? principal.workspaceId : null,
    role: null,
    db: db as MyraToolContext["db"],
  }
}

async function collect(gen: AsyncGenerator<MyraStreamEvent>): Promise<MyraStreamEvent[]> {
  const out: MyraStreamEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

const USER: MyraPrincipal = {
  kind: "user",
  accountId: "acct_1",
  sessionId: "sess_1",
  workspaceId: "ws_1",
  role: "MEMBER",
}
const ANON: MyraPrincipal = { kind: "anonymous", publicSessionId: "pubsess_1" }

describe("runTaskLoop structured booking request", () => {
  it("starts no tools or provider work for an already stopped turn", async () => {
    const abort = new AbortController()
    abort.abort()
    const { db, ops } = fakeDb()
    const generate = vi.fn()
    const events = await collect(
      runTaskLoop({
        ctx: toolCtx(ANON, db),
        text: "Book a demo",
        assistantMessageId: "stopped-msg",
        traceId: "stopped-trace",
        signal: abort.signal,
        provider: { name: "mock", generate },
      })
    )
    expect(ops).toHaveLength(0)
    expect(generate).not.toHaveBeenCalled()
    expect(events.map((event) => event.type)).toEqual(["ready"])
  })
  it("drives book_demo directly without parsing name/email from text", async () => {
    const slotStart = nextOnGridSlotIso()
    const { db, ops } = fakeDb({ userEmail: "eval@example.com" })
    const events = await collect(
      runTaskLoop({
        ctx: toolCtx(USER, db),
        // Deliberately free of parseable name/email — only the structured
        // request can produce a proposal.
        text: `Book the demo slot that starts at ${slotStart}.`,
        bookingRequest: {
          slotStart,
          timezone: "Asia/Kolkata",
          name: "Eval User",
          email: "eval@example.com",
        },
        assistantMessageId: "msg_1",
        traceId: "tr_1",
        provider: new MockProvider(),
      })
    )

    const proposal = events.find((e) => e.type === "proposal")
    expect(proposal?.type === "proposal" && proposal.proposal.operationName).toBe("book_demo")
    const confirmCard = events.find(
      (e) => e.type === "component" && e.component.type === "action_confirmation"
    )
    expect(confirmCard).toBeTruthy()
    const done = events.find((e) => e.type === "done")
    expect(done?.type === "done" && done.taskRecord.outcome).toBe("action_proposed")
    expect(done?.type === "done" && done.taskRecord.toolsUsed).toContain("book_demo")
    expect(done?.type === "done" && done.taskRecord.toolsUsed).not.toContain("get_demo_slots")
    const stored = ops.find((o) => o.operationName === "book_demo") as
      | { payload?: { slotStart?: string; email?: string; name?: string; timezone?: string } }
      | undefined
    expect(stored?.payload?.slotStart).toBe(slotStart)
    expect(stored?.payload?.email).toBe("eval@example.com")
    expect(stored?.payload?.name).toBe("Eval User")
  })

  it("keeps the regex path working when no bookingRequest is sent", async () => {
    const slotStart = nextOnGridSlotIso()
    // The regex captures YYYY-MM-DDTHH:MM without an offset and re-parses it
    // in the machine's local zone — render the same instant locally so the
    // assertion is host-timezone independent.
    const textSlot = localIsoMinute(new Date(slotStart))
    const { db } = fakeDb({ userEmail: "eval@example.com" })
    const events = await collect(
      runTaskLoop({
        ctx: toolCtx(USER, db),
        // Note: the regex fallback captures a trailing "." into the email, so
        // keep the email terminal — another reason the structured path exists.
        text: `Book a demo at ${textSlot}. My name is Eval User. Email: eval@example.com`,
        assistantMessageId: "msg_2",
        traceId: "tr_2",
        provider: new MockProvider(),
      })
    )
    const proposal = events.find((e) => e.type === "proposal")
    expect(proposal?.type === "proposal" && proposal.proposal.operationName).toBe("book_demo")
  })

  it("surfaces the verification-required path for anonymous submitters", async () => {
    const slotStart = nextOnGridSlotIso()
    const { db } = fakeDb()
    const events = await collect(
      runTaskLoop({
        ctx: toolCtx(ANON, db),
        text: `Book the demo slot that starts at ${slotStart}.`,
        bookingRequest: {
          slotStart,
          timezone: "Asia/Kolkata",
          name: "Anon User",
          email: "anon@example.com",
        },
        assistantMessageId: "msg_3",
        traceId: "tr_3",
        provider: new MockProvider(),
      })
    )
    // No silent booking, no hard error — the turn explains verification.
    expect(events.some((e) => e.type === "proposal")).toBe(false)
    expect(events.some((e) => e.type === "error")).toBe(false)
    const tokens = events
      .filter((e) => e.type === "token")
      .map((e) => (e.type === "token" ? e.text : ""))
      .join("")
    expect(tokens.toLowerCase()).toContain("verify")
  })
})
