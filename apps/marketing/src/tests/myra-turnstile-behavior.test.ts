/**
 * Behavioral contract for the Myra Turnstile lifecycle (review findings
 * F1/F2):
 *
 *  F1 — a challenge must render where the visitor can see it. The widget used
 *       to bind once to the first [data-myra-turnstile] host; when that host
 *       was later hidden (the demo page swaps booking steps, the panel
 *       closes) a required interaction challenge became unreachable. Each
 *       request now picks a currently-visible host and renders a fresh
 *       widget, which is removed when the attempt settles.
 *  F2 — Turnstile tokens are single-use. Concurrent callers used to share
 *       one in-flight challenge, so two credential-issuing operations
 *       received the same token and only the first could pass server
 *       verification. Callers now serialize; each gets its own challenge.
 *
 * Runs under the marketing Vitest suite against a minimal fake document, the
 * same pattern as myra-slot-booking.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface TurnstileOptions {
  sitekey: string
  size?: string
  appearance?: string
  execution?: string
  callback?: (token: string) => void
  "error-callback"?: () => void
  "expired-callback"?: () => void
}

interface FakeEl {
  tagName: string
  children: FakeEl[]
  parent: FakeEl | null
  attrs: Record<string, string>
  style: Record<string, string>
  visible: boolean
  src: string
  async: boolean
  onload: (() => void) | null
  onerror: (() => void) | null
  appendChild(child: FakeEl): FakeEl
  setAttribute(name: string, value: string): void
  getClientRects(): object[]
  remove(): void
}

function fakeEl(tag: string): FakeEl {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    children: [],
    parent: null,
    attrs: {},
    style: {},
    visible: true,
    src: "",
    async: false,
    onload: null,
    onerror: null,
    appendChild(child) {
      child.parent = el
      el.children.push(child)
      return child
    },
    setAttribute(name, value) {
      el.attrs[name] = value
    },
    getClientRects() {
      return el.visible ? [{}] : []
    },
    remove() {
      if (el.parent) {
        el.parent.children = el.parent.children.filter((c) => c !== el)
        el.parent = null
      }
    },
  }
  return el
}

function turnstileHost(): FakeEl {
  const el = fakeEl("div")
  el.setAttribute("data-myra-turnstile", "")
  return el
}

interface RenderCall {
  id: string
  host: FakeEl
  options: TurnstileOptions
}

function fakeTurnstile() {
  const renders: RenderCall[] = []
  const executions: string[] = []
  const removals: string[] = []
  let seq = 0
  return {
    renders,
    executions,
    removals,
    render(host: FakeEl, options: TurnstileOptions) {
      const id = `widget-${++seq}`
      renders.push({ id, host, options })
      return id
    },
    execute(id: string) {
      executions.push(id)
    },
    remove(id: string) {
      removals.push(id)
    },
  }
}

interface FakeDocument {
  head: FakeEl
  body: FakeEl
  hosts: FakeEl[]
  createElement(tag: string): FakeEl
  querySelectorAll(selector: string): FakeEl[]
}

function fakeDocument(): FakeDocument {
  const doc: FakeDocument = {
    head: fakeEl("head"),
    body: fakeEl("body"),
    hosts: [],
    createElement: (tag) => fakeEl(tag),
    querySelectorAll: (selector) => (selector === "[data-myra-turnstile]" ? [...doc.hosts] : []),
  }
  return doc
}

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

/** Flush the microtask queue — works under real and fake timers. */
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

let doc: FakeDocument
let turnstile: ReturnType<typeof fakeTurnstile>
let w: { turnstile?: unknown }

beforeEach(() => {
  doc = fakeDocument()
  turnstile = fakeTurnstile()
  w = { turnstile }
  ;(globalThis as { document?: unknown }).document = doc
  ;(globalThis as { window?: unknown }).window = w
  ;(globalThis as { localStorage?: unknown }).localStorage = memoryStorage()
  vi.stubEnv("PUBLIC_TURNSTILE_SITE_KEY", "test-site-key")
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  delete (globalThis as { document?: unknown }).document
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { localStorage?: unknown }).localStorage
})

async function loadSession() {
  vi.resetModules()
  return import("../components/myra/myra-session")
}

describe("Turnstile challenge lifecycle", () => {
  it("renders an interaction-only widget driven by explicit execute()", async () => {
    const { getTurnstileToken } = await loadSession()
    const p = getTurnstileToken()
    await tick()
    const call = turnstile.renders[0]
    expect(call?.options.appearance).toBe("interaction-only")
    expect(call?.options.execution).toBe("execute")
    expect(call?.options.size).toBe("flexible")
    expect(call?.options.sitekey).toBe("test-site-key")
    expect(turnstile.executions).toEqual([call?.id])
    call?.options.callback?.("t")
    await expect(p).resolves.toBe("t")
  })

  it("returns undefined when no site key is configured", async () => {
    vi.stubEnv("PUBLIC_TURNSTILE_SITE_KEY", "")
    const { getTurnstileToken } = await loadSession()
    await expect(getTurnstileToken()).resolves.toBeUndefined()
    expect(turnstile.renders).toHaveLength(0)
  })

  it("gives each concurrent caller its own fresh single-use token", async () => {
    const { getTurnstileToken } = await loadSession()
    doc.hosts.push(turnstileHost())

    const p1 = getTurnstileToken()
    const p2 = getTurnstileToken()
    await tick()

    // Serialized — only the first challenge is in flight.
    expect(turnstile.renders).toHaveLength(1)
    turnstile.renders[0]?.options.callback?.("token-1")
    const t1 = await p1
    await tick()

    expect(turnstile.renders).toHaveLength(2)
    turnstile.renders[1]?.options.callback?.("token-2")
    const t2 = await p2

    expect(t1).toBe("token-1")
    expect(t2).toBe("token-2")
    expect(turnstile.executions).toHaveLength(2)
  })

  it("renders each challenge into a currently-visible host", async () => {
    const { getTurnstileToken } = await loadSession()
    const hostA = turnstileHost()
    const hostB = turnstileHost()
    doc.hosts.push(hostA, hostB)

    const p1 = getTurnstileToken()
    await tick()
    expect(turnstile.renders[0]?.host).toBe(hostA)
    turnstile.renders[0]?.options.callback?.("t1")
    await p1

    // The first host becomes unreachable (booking-step swap, panel close)
    // while a different host is now visible.
    hostA.visible = false
    const p2 = getTurnstileToken()
    await tick()
    expect(turnstile.renders).toHaveLength(2)
    expect(turnstile.renders[1]?.host).toBe(hostB)
    turnstile.renders[1]?.options.callback?.("t2")
    await expect(p2).resolves.toBe("t2")
  })

  it("falls back to a hidden holder only when no host is visible, then removes it", async () => {
    const { getTurnstileToken } = await loadSession()
    const hidden = turnstileHost()
    hidden.visible = false
    doc.hosts.push(hidden)

    const p = getTurnstileToken()
    await tick()
    expect(turnstile.renders).toHaveLength(1)
    const holder = turnstile.renders[0]?.host
    expect(holder).not.toBe(hidden)
    expect(holder?.attrs["aria-hidden"]).toBe("true")
    expect(doc.body.children).toContain(holder)

    turnstile.renders[0]?.options.callback?.("t")
    await expect(p).resolves.toBe("t")
    expect(doc.body.children).not.toContain(holder)
  })

  it("a timed-out attempt cannot settle a later request", async () => {
    vi.useFakeTimers()
    const { getTurnstileToken } = await loadSession()

    const p1 = getTurnstileToken()
    await tick()
    expect(turnstile.renders).toHaveLength(1)
    const staleCallback = turnstile.renders[0]?.options.callback
    const staleId = turnstile.renders[0]?.id

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(p1).resolves.toBeUndefined()
    expect(turnstile.removals).toContain(staleId)

    const p2 = getTurnstileToken()
    await tick()
    expect(turnstile.renders).toHaveLength(2)

    // The timed-out widget's callback arrives late; the in-flight request
    // must wait for its own challenge.
    staleCallback?.("stale-token")
    turnstile.renders[1]?.options.callback?.("fresh-token")
    await expect(p2).resolves.toBe("fresh-token")
  })

  it("a failed challenge resolves undefined and does not poison the queue", async () => {
    const { getTurnstileToken } = await loadSession()
    const p1 = getTurnstileToken()
    await tick()
    turnstile.renders[0]?.options["error-callback"]?.()
    await expect(p1).resolves.toBeUndefined()

    const p2 = getTurnstileToken()
    await tick()
    expect(turnstile.renders).toHaveLength(2)
    turnstile.renders[1]?.options.callback?.("t2")
    await expect(p2).resolves.toBe("t2")
  })

  it("an expired token fails the attempt closed", async () => {
    const { getTurnstileToken } = await loadSession()
    const p = getTurnstileToken()
    await tick()
    turnstile.renders[0]?.options["expired-callback"]?.()
    await expect(p).resolves.toBeUndefined()
  })

  it("a blocked script fails closed and a later request retries the load", async () => {
    w.turnstile = undefined
    const { getTurnstileToken } = await loadSession()

    const p1 = getTurnstileToken()
    await tick()
    const scripts = doc.head.children.filter((c) => c.tagName === "SCRIPT")
    expect(scripts).toHaveLength(1)
    scripts[0]?.onerror?.()
    await expect(p1).resolves.toBeUndefined()

    // The failure is not cached — the next request appends a fresh tag, and
    // this load succeeds once the Turnstile global appears.
    const p2 = getTurnstileToken()
    await tick()
    const scriptsNow = doc.head.children.filter((c) => c.tagName === "SCRIPT")
    expect(scriptsNow).toHaveLength(2)
    w.turnstile = turnstile
    scriptsNow[1]?.onload?.()
    await tick()
    expect(turnstile.renders).toHaveLength(1)
    turnstile.renders[0]?.options.callback?.("t")
    await expect(p2).resolves.toBe("t")
  })
})

describe("session bootstrap deduplication", () => {
  it("concurrent ensureMyraSession callers share one mint and one challenge", async () => {
    const fetches: string[] = []
    ;(globalThis as { fetch?: unknown }).fetch = vi.fn(async (url: string) => {
      fetches.push(url)
      return {
        ok: true,
        json: async () => ({ data: { publicToken: "pub", sessionId: "sid" } }),
      }
    })
    const { ensureMyraSession } = await loadSession()

    const a = ensureMyraSession("https://api.test")
    const b = ensureMyraSession("https://api.test")
    await tick()
    expect(turnstile.renders).toHaveLength(1)
    turnstile.renders[0]?.options.callback?.("token-1")
    await Promise.all([a, b])

    expect(fetches).toEqual(["https://api.test/api/myra/session"])
    // The minted token is stored, so a later bootstrap is a no-op.
    await ensureMyraSession("https://api.test")
    await tick()
    expect(fetches).toHaveLength(1)
    expect(turnstile.renders).toHaveLength(1)
  })
})
