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
      callback?: (token: string) => void
      "error-callback"?: () => void
      "expired-callback"?: () => void
    }
  ) => string
  execute: (widgetId: string) => void
  reset: (widgetId: string) => void
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
let turnstileWidgetId: string | undefined
let turnstileResolve: ((token: string | undefined) => void) | null = null
let turnstileInFlight: Promise<string | undefined> | null = null

function loadTurnstile(): Promise<TurnstileGlobal | undefined> {
  if (turnstileScript) return turnstileScript
  turnstileScript = new Promise((resolve) => {
    const w = window as Window & { turnstile?: TurnstileGlobal }
    const done = () => resolve(w.turnstile)
    if (w.turnstile) {
      done()
      return
    }
    const script = document.createElement("script")
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    script.async = true
    script.onload = done
    script.onerror = () => resolve(undefined)
    add(document.head, script)
    setTimeout(() => resolve(w.turnstile), 15_000)
  })
  return turnstileScript
}

/**
 * Fresh Turnstile token, or undefined when no site key is configured / the
 * challenge can't run. Single-use — call once per credential-issuing request.
 *
 * Single-flight: concurrent callers share one in-flight challenge. The demo
 * page bootstraps its session twice on load (once for the panel wiring, once
 * inside fetchSlots); without this guard the second call reset()s and
 * execute()s a widget that is already executing, the token callback fires for
 * only one of them, and the loser times out and mints an unauthenticated
 * session.
 */
export function getTurnstileToken(): Promise<string | undefined> {
  turnstileInFlight ??= requestTurnstileToken().finally(() => {
    turnstileInFlight = null
  })
  return turnstileInFlight
}

async function requestTurnstileToken(): Promise<string | undefined> {
  const sitekey = (import.meta.env.PUBLIC_TURNSTILE_SITE_KEY as string | undefined) || ""
  if (!sitekey || typeof window === "undefined") return undefined
  const turnstile = await loadTurnstile()
  if (!turnstile) return undefined
  try {
    if (turnstileWidgetId === undefined) {
      const host = document.querySelector<HTMLElement>(MYRA_TURNSTILE_SELECTOR)
      // getClientRects() is the visibility test that survives a fixed-position
      // ancestor (offsetParent is always null inside position: fixed, which is
      // exactly how the Myra panel is positioned).
      const visibleHost = host && host.getClientRects().length > 0 ? host : null
      const holder = visibleHost ?? document.createElement("div")
      if (!visibleHost) {
        holder.setAttribute("aria-hidden", "true")
        holder.style.position = "absolute"
        holder.style.width = "0"
        holder.style.height = "0"
        holder.style.overflow = "hidden"
        add(document.body, holder)
      }
      turnstileWidgetId = turnstile.render(holder, {
        sitekey,
        size: "flexible",
        appearance: "interaction-only",
        callback: (token) => {
          turnstileResolve?.(token)
          turnstileResolve = null
        },
        "error-callback": () => {
          turnstileResolve?.(undefined)
          turnstileResolve = null
        },
      })
    }
    const widgetId = turnstileWidgetId
    return await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (turnstileResolve === settle) {
          turnstileResolve = null
          resolve(undefined)
        }
      }, 15_000)
      const settle = (token: string | undefined) => {
        clearTimeout(timer)
        resolve(token)
      }
      turnstileResolve = settle
      turnstile.reset(widgetId)
      turnstile.execute(widgetId)
    })
  } catch {
    return undefined
  }
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

async function mintMyraSession(
  apiBase: string,
  surface: "MARKETING" | "DASHBOARD"
): Promise<void> {
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
