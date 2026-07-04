type LogLevel = "debug" | "info" | "warn" | "error"

interface LogEntry {
  level: LogLevel
  message: string
  timestamp: string
  [key: string]: unknown
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function getMinLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined
  return envLevel && envLevel in LOG_LEVELS ? envLevel : "info"
}

const CACHED_MIN_LEVEL = getMinLevel()

// ── Redaction ────────────────────────────────────────────────────────────────
// This logger is a shared primitive used by every package, so it must never
// let a secret reach stdout/log aggregation. Any object key whose (lowercased)
// name contains one of these markers has its value masked, recursively.
const SENSITIVE_KEY_MARKERS = [
  "password",
  "secret",
  "token", // accessToken, refreshToken, idToken, csrfToken, webhookSecret handled by "secret"
  "authorization",
  "apikey",
  "accesskey",
  "privatekey",
  "cookie",
  "credential",
  "vaultref",
  "verificationurl",
  "otp",
]

const REDACTED = "[REDACTED]"
const MAX_DEPTH = 8
const MAX_SERIALIZED_CHARS = 20_000

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase()
  return SENSITIVE_KEY_MARKERS.some((m) => k.includes(m))
}

// Recursively copy `value`, masking sensitive keys and breaking cycles.
function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value !== "object") return value
  if (depth > MAX_DEPTH) return "[Truncated: max depth]"
  if (seen.has(value as object)) return "[Circular]"
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen, depth + 1))
  }

  // Errors don't enumerate message/stack via spread — capture them explicitly.
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, seen, depth + 1)
  }
  return out
}

function safeStringify(entry: LogEntry): string {
  let serialized: string
  try {
    const redacted = redact(entry, new WeakSet(), 0) as Record<string, unknown>
    serialized = JSON.stringify(redacted)
  } catch (err) {
    serialized = JSON.stringify({
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp,
      _logError: `Failed to serialize log meta: ${String(err)}`,
    })
  }
  if (serialized.length > MAX_SERIALIZED_CHARS) {
    serialized = serialized.slice(0, MAX_SERIALIZED_CHARS) + '...[truncated]"}'
  }
  return serialized
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LOG_LEVELS[level] < LOG_LEVELS[CACHED_MIN_LEVEL]) return

  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  }

  const formatted = safeStringify(entry)

  if (level === "error") {
    console.error(formatted)
  } else if (level === "warn") {
    console.warn(formatted)
  } else {
    console.log(formatted)
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: Record<string, unknown>) =>
      log("debug", message, { scope, ...meta }),
    info: (message: string, meta?: Record<string, unknown>) =>
      log("info", message, { scope, ...meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      log("warn", message, { scope, ...meta }),
    error: (message: string, meta?: Record<string, unknown>) =>
      log("error", message, { scope, ...meta }),
  }
}

// Exported for unit testing the redaction/serialization policy.
export const __test = { redact, safeStringify, isSensitiveKey }

export type { LogLevel, LogEntry }
