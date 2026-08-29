export type WebMcpReceiptStatus = "running" | "completed" | "cancelled" | "failed"

export type WebMcpClassification = "read" | "ui-only" | "mutation-prepared"

export type WebMcpDataClass = "public" | "workspace-summary" | "untrusted-finding" | "source-local"

export interface WebMcpActivityReceipt {
  id: string
  toolName: string
  classification: WebMcpClassification
  status: WebMcpReceiptStatus
  dataClass: WebMcpDataClass
  untrustedContent: boolean
  uiChanged: boolean
  durableMutation: false
  humanConfirmationRequired: boolean
  startedAt: string
  endedAt?: string
  summary: string
}

export interface WebMcpReceiptStoreSnapshot {
  receipts: readonly WebMcpActivityReceipt[]
  latest: WebMcpActivityReceipt | null
}

export type WebMcpReceiptListener = () => void

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
