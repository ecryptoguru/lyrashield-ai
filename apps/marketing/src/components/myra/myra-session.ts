/**
 * Shared public-session bootstrap for Myra browser flows (panel + demo page).
 * The public token persists in localStorage so returning visitors keep their
 * anonymous history; a 401 triggers a re-bootstrap.
 *
 * Anonymous session mints and identity-code requests are credential-issuing
 * surfaces — they pass a Turnstile token when a site key is configured.
 */

export const MYRA_TOKEN_KEY = "myra_public_token"
export const MYRA_SESSION_ID_KEY = "myra_public_session_id"
export const MYRA_MEMORY_KEY = "myra_session_memory"

export function getMyraSessionMemory(): Record<string, string> {
  try {
    const existing = sessionStorage.getItem(MYRA_MEMORY_KEY)
    if (existing) return JSON.parse(existing) as Record<string, string>
    const memory = {
      preferred_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      preferred_locale: navigator.language || "en",
    }
    sessionStorage.setItem(MYRA_MEMORY_KEY, JSON.stringify(memory))
    return memory
  } catch {
    return {}
  }
}

export function myraApiBase(): string {
  return (
    (import.meta.env.PUBLIC_APP_URL as string | undefined) || "https://app.lyrashieldai.com"
  ).replace(/\/$/, "")
}

export function getMyraToken(): string | null {
  try {
    return localStorage.getItem(MYRA_TOKEN_KEY)
  } catch {
    return null
  }
}

export function getMyraSessionId(): string | null {
  try {
    return localStorage.getItem(MYRA_SESSION_ID_KEY)
  } catch {
    return null
  }
}

export function clearMyraToken(): void {
  try {
    localStorage.removeItem(MYRA_TOKEN_KEY)
    localStorage.removeItem(MYRA_SESSION_ID_KEY)
    sessionStorage.removeItem(MYRA_MEMORY_KEY)
  } catch {
    /* storage unavailable */
  }
}

// ─── Turnstile (lazy, invisible until interaction is required) ───────────────

interface TurnstileGlobal {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string
      size?: "normal" | "compact" | "flexible"
      appearance?: "always" | "execute" | "interaction-only"
      execution?: "auto" | "execute"
      callback?: (token: string) => void
      "error-callback"?: () => void
      "expired-callback"?: () => void
    }
  ) => string
  execute: (widgetId: string) => void
  remove: (widgetId: string) => void
}

/**
 * Host element for the challenge widget. When one is present and visible the
 * widget renders inside it, so an interaction challenge can actually be
 * completed; otherwise it renders into a hidden holder — managed challenges
 * still pass without user interaction, which is the common case.
 */
export const MYRA_TURNSTILE_SELECTOR = "[data-myra-turnstile]"

/** DOM append via Node.appendChild — workerd's Element.append shadows the
 *  variadic ParentNode signature in this project's type environment. */
function add(parent: Node, kid: Node): void {
  parent.appendChild(kid)
}

let turnstileScript: Promise<TurnstileGlobal | undefined> | null = null
let turnstileQueue: Promise<void> = Promise.resolve()

/** Interactive challenges need human time; managed ones settle in ~1s or fail fast. */
const TURNSTILE_TIMEOUT_MS = 60_000
const TURNSTILE_SCRIPT_TIMEOUT_MS = 15_000

function loadTurnstile(): Promise<TurnstileGlobal | undefined> {
  turnstileScript ??= new Promise((resolve) => {
    const w = window as Window & { turnstile?: TurnstileGlobal }
    if (w.turnstile) {
      resolve(w.turnstile)
      return
    }
    // A failed or stalled load must not be cached forever — clear the cached
    // promise so a later request retries the script load.
    const fail = () => {
      turnstileScript = null
      resolve(undefined)
    }
    const script = document.createElement("script")
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    script.async = true
    const timer = setTimeout(
      () => (w.turnstile ? resolve(w.turnstile) : fail()),
      TURNSTILE_SCRIPT_TIMEOUT_MS
    )
    script.onload = () => {
      clearTimeout(timer)
      resolve(w.turnstile)
    }
    script.onerror = () => {
      clearTimeout(timer)
      fail()
    }
    add(document.head, script)
  })
  return turnstileScript
}

/** First currently-visible challenge host, or null. getClientRects() is the
 *  visibility test that survives a fixed-position ancestor (offsetParent is
 *  always null inside position: fixed, which is exactly how the Myra panel is
 *  positioned). */
function pickTurnstileHost(): HTMLElement | null {
  for (const host of document.querySelectorAll<HTMLElement>(MYRA_TURNSTILE_SELECTOR)) {
    if (host.getClientRects().length > 0) return host
  }
  return null
}

/**
 * Fresh Turnstile token, or undefined when no site key is configured / the
 * challenge can't run. Single-use — call once per credential-issuing request.
 *
 * Serialized, not shared: Turnstile tokens are single-use, so independent
 * credential-issuing callers queue and each receives its own fresh challenge.
 * Sharing one in-flight attempt would hand the same single-use credential to
 * every concurrent caller and only the first server verification could pass.
 * The deduplication that IS correct — concurrent session bootstraps sharing
 * one mint — lives in ensureMyraSession.
 */
export function getTurnstileToken(): Promise<string | undefined> {
  const attempt = turnstileQueue.then(requestTurnstileToken)
  turnstileQueue = attempt.then(
    () => undefined,
    () => undefined
  )
  return attempt
}

async function requestTurnstileToken(): Promise<string | undefined> {
  try {
    const sitekey = (import.meta.env.PUBLIC_TURNSTILE_SITE_KEY as string | undefined) || ""
    if (!sitekey || typeof window === "undefined") return undefined
    const turnstile = await loadTurnstile()
    if (!turnstile) return undefined

    // A fresh widget per request, in the host that is visible right now. The
    // host used for a previous token may since have been hidden — the demo
    // page swaps booking steps, the panel opens and closes — and a challenge
    // rendered where the visitor cannot see it can never be completed. Only
    // when no host is visible, fail this attempt without starting a challenge.
    // An interaction-only widget inside a hidden holder can require input the
    // visitor has no way to provide. Both Myra surfaces keep a host visible.
    const host = pickTurnstileHost()
    if (!host) return undefined

    let widgetId: string | undefined
    const cleanup = () => {
      if (widgetId !== undefined) {
        try {
          turnstile.remove(widgetId)
        } catch {
          /* widget already gone */
        }
        widgetId = undefined
      }
    }

    try {
      return await new Promise<string | undefined>((resolve) => {
        const settle = (token: string | undefined) => {
          clearTimeout(timer)
          cleanup()
          resolve(token)
        }
        const timer = setTimeout(() => settle(undefined), TURNSTILE_TIMEOUT_MS)
        widgetId = turnstile.render(host, {
          sitekey,
          size: "flexible",
          appearance: "interaction-only",
          execution: "execute",
          callback: settle,
          "error-callback": () => settle(undefined),
          "expired-callback": () => settle(undefined),
        })
        turnstile.execute(widgetId)
      })
    } catch {
      cleanup()
      return undefined
    }
  } catch {
    return undefined
  }
}

// ─── Public capability probe ─────────────────────────────────────────────────

export interface MyraStatus {
  public: boolean
  booking: boolean
}

const STATUS_TIMEOUT_MS = 2_000
const STATUS_CLOSED: MyraStatus = Object.freeze({ public: false, booking: false })

/**
 * GET /api/myra/status — what the app will actually let this visitor do right
 * now. Marketing renders only what this reports: the launcher needs
 * `public`, the /demo slot picker needs `booking`. Any failure — network,
 * non-2xx, malformed body — resolves to both false so a degraded app can
 * never leave a dead Myra affordance on the page. Bounded at 2s: the probe
 * sits in the critical render path of the launcher.
 */
export function fetchMyraStatus(apiBase = myraApiBase()): Promise<MyraStatus> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS)
  return fetch(`${apiBase}/api/myra/status`, {
    headers: { accept: "application/json" },
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) return STATUS_CLOSED
      const body = (await res.json().catch(() => ({}))) as {
        public?: unknown
        booking?: unknown
      }
      return { public: body.public === true, booking: body.booking === true }
    })
    .catch(() => STATUS_CLOSED)
    .finally(() => clearTimeout(timer))
}

// ─── Session bootstrap ───────────────────────────────────────────────────────

/**
 * POST /api/myra/session — resolves the cookie session or mints an anonymous
 * public session. Response envelope is { success, data: { principal,
 * publicToken? } }; the token is stored under `myra_public_token`.
 *
 * Single-flight: callers that race on page load share one mint instead of
 * issuing two credential-minting requests (and two Turnstile challenges).
 */
export function ensureMyraSession(
  apiBase = myraApiBase(),
  surface: "MARKETING" | "DASHBOARD" = "MARKETING"
): Promise<void> {
  if (getMyraToken()) return Promise.resolve()
  sessionBootstrap ??= mintMyraSession(apiBase, surface).finally(() => {
    sessionBootstrap = null
  })
  return sessionBootstrap
}

let sessionBootstrap: Promise<void> | null = null

async function mintMyraSession(apiBase: string, surface: "MARKETING" | "DASHBOARD"): Promise<void> {
  const turnstileToken = await getTurnstileToken()
  const res = await fetch(`${apiBase}/api/myra/session`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ surface, ...(turnstileToken ? { turnstileToken } : {}) }),
  })
  if (!res.ok) await readMyraError(res)
  const body = (await res.json().catch(() => ({}))) as {
    data?: { principal?: string; publicToken?: string; sessionId?: string }
  }
  const data = body.data ?? {}
  try {
    if (data.publicToken) localStorage.setItem(MYRA_TOKEN_KEY, data.publicToken)
    if (data.sessionId) localStorage.setItem(MYRA_SESSION_ID_KEY, data.sessionId)
  } catch {
    /* storage unavailable — session stays in-memory only */
  }
}

/** Headers shared by the public Myra endpoints (session bearer when present). */
export function myraHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...extra,
  }
  const token = getMyraToken()
  if (token) h["x-myra-session"] = token
  return h
}

/** Read the server error body ({error:{code,message}}) into a typed error. */
export async function readMyraError(res: Response): Promise<never> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    const err = new Error(body.error?.message ?? `Request failed (${res.status})`)
    ;(err as Error & { code?: string }).code = body.error?.code ?? `HTTP_${res.status}`
    throw err
  } catch (e) {
    if ((e as Error & { code?: string }).code) throw e
    const err = new Error(`Request failed (${res.status})`)
    ;(err as Error & { code?: string }).code = `HTTP_${res.status}`
    throw err
  }
}
