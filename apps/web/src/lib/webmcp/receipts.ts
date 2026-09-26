type WebMcpReceiptStatus = "running" | "completed" | "cancelled" | "failed"

export type WebMcpClassification = "read" | "ui-only" | "mutation-prepared" | "mutation-durable"

export type WebMcpDataClass = "public" | "workspace-summary" | "untrusted-finding" | "source-local"

export interface WebMcpActivityReceipt {
  id: string
  toolName: string
  classification: WebMcpClassification
  status: WebMcpReceiptStatus
  dataClass: WebMcpDataClass
  untrustedContent: boolean
  uiChanged: boolean
  /** True only for tools that persist a server-side action (W3-07). */
  durableMutation: boolean
  humanConfirmationRequired: boolean
  startedAt: string
  endedAt?: string
  summary: string
  /**
   * Safe operation references for recovery — e.g. the accepted scan id,
   * operation id, or the caller's idempotency request id. Sanitized through
   * {@link sanitizeReceiptReferences}; tenancy and credential-shaped keys are
   * always dropped.
   */
  references?: Record<string, string>
  /**
   * Relative in-dashboard recovery path (`/dashboard/...`). Anything else —
   * external URLs, evidence/storage URIs, share links with query secrets —
   * is dropped by {@link safeDashboardHref} and never rendered.
   */
  href?: string
}

interface WebMcpReceiptStoreSnapshot {
  receipts: readonly WebMcpActivityReceipt[]
  latest: WebMcpActivityReceipt | null
}

type WebMcpReceiptListener = () => void

const MAX_SESSION_RECEIPTS = 20

const SENSITIVE_INPUT_KEYS = [
  /workspace/i,
  /user/i,
  /api[-_]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /evidence/i,
  /location/i,
  /permission/i,
  /role/i,
  /repo[-_]?url/i,
  /api[-_]?spec/i,
] as const

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_INPUT_KEYS.some((pattern) => pattern.test(key))
}

function redactValue(value: unknown, maxLength = 200): unknown {
  if (value === null || value === undefined) return value

  if (typeof value === "string") {
    if (value.length > maxLength) {
      return `${value.slice(0, maxLength)}…`
    }
    return value
  }

  if (typeof value === "number" || typeof value === "boolean") return value

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, maxLength))
  }

  if (typeof value === "object" && value !== null) {
    const redacted: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        redacted[key] = "[REDACTED]"
      } else {
        redacted[key] = redactValue(val, maxLength)
      }
    }
    return redacted
  }

  return value
}

export function redactToolInputs<T extends Record<string, unknown>>(input: T): T {
  return redactValue(input) as T
}

/**
 * A receipt href is only ever an in-app navigation target. The allowlist is a
 * plain `/dashboard/...` path with no query string or fragment, so a recovery
 * link can never carry an external URL, an evidence/storage URI, or query
 * secrets (share tokens, signed parameters).
 */
const DASHBOARD_HREF_PATTERN = /^\/dashboard\/[A-Za-z0-9][A-Za-z0-9/_-]{0,198}$/

export function safeDashboardHref(href: unknown): string | undefined {
  if (typeof href !== "string") return undefined
  const trimmed = href.trim()
  if (trimmed.includes("?") || trimmed.includes("#")) return undefined
  if (trimmed.includes("..")) return undefined
  return DASHBOARD_HREF_PATTERN.test(trimmed) ? trimmed : undefined
}

const MAX_RECEIPT_REFERENCES = 8
const MAX_RECEIPT_REFERENCE_LENGTH = 200

/**
 * Bound a tool-provided reference map to safe, displayable values: string
 * values only, bounded count and length, and tenancy/credential-shaped keys
 * (workspaceId, userId, token, evidence…) always dropped — a receipt carries
 * operation references, never principals or secrets.
 */
export function sanitizeReceiptReferences(references: unknown): Record<string, string> | undefined {
  if (!references || typeof references !== "object" || Array.isArray(references)) {
    return undefined
  }
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(references)) {
    if (Object.keys(clean).length >= MAX_RECEIPT_REFERENCES) break
    if (isSensitiveKey(key)) continue
    if (typeof value !== "string" || value.length === 0) continue
    // A reference is an identifier, never a locator: drop anything URI-shaped
    // (evidence locations, signed URLs, external links).
    if (value.includes("://")) continue
    clean[key] =
      value.length > MAX_RECEIPT_REFERENCE_LENGTH
        ? `${value.slice(0, MAX_RECEIPT_REFERENCE_LENGTH)}…`
        : value
  }
  return Object.keys(clean).length > 0 ? clean : undefined
}

function createReceiptId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // Fallback for older environments / tests.
  return `wmcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface WebMcpReceiptStore {
  add(receipt: Omit<WebMcpActivityReceipt, "id" | "startedAt">): WebMcpActivityReceipt
  update(id: string, patch: Partial<WebMcpActivityReceipt>): WebMcpActivityReceipt | null
  clear(): void
  getSnapshot(): WebMcpReceiptStoreSnapshot
  subscribe(listener: WebMcpReceiptListener): () => void
}

export function createWebMcpReceiptStore(): WebMcpReceiptStore {
  const receipts: WebMcpActivityReceipt[] = []
  const listeners = new Set<WebMcpReceiptListener>()
  let snapshot: WebMcpReceiptStoreSnapshot = { receipts: [], latest: null }

  function updateSnapshot() {
    snapshot = {
      receipts: receipts.slice(),
      latest: receipts[0] ?? null,
    }
  }

  function notify() {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // Receipt listeners must never crash the store.
      }
    }
  }

  return {
    add(receipt) {
      const full: WebMcpActivityReceipt = {
        ...receipt,
        id: createReceiptId(),
        startedAt: new Date().toISOString(),
      }
      receipts.unshift(full)
      while (receipts.length > MAX_SESSION_RECEIPTS) {
        receipts.pop()
      }
      updateSnapshot()
      notify()
      return full
    },

    update(id, patch) {
      const index = receipts.findIndex((r) => r.id === id)
      if (index === -1) return null
      const updated: WebMcpActivityReceipt = {
        ...receipts[index],
        ...patch,
      } as WebMcpActivityReceipt
      receipts[index] = updated
      updateSnapshot()
      notify()
      return updated
    },

    clear() {
      if (receipts.length === 0) return
      receipts.length = 0
      updateSnapshot()
      notify()
    },

    getSnapshot() {
      return snapshot
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
