import type { ErrorEvent, StackFrame } from "@sentry/nextjs"

const ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "NetworkError",
  "AbortError",
  "ChunkLoadError",
])

const STATIC_ROUTES = new Set([
  "/",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/onboarding",
  "/dashboard",
  "/dashboard/scans",
  "/dashboard/findings",
  "/dashboard/reports",
  "/dashboard/launch-readiness",
  "/dashboard/settings",
  "/dashboard/billing",
  "/dashboard/integrations",
  "/dashboard/members",
  "/dashboard/targets",
  "/dashboard/affiliates",
  "/dashboard/admin",
])

const PRIVATE_ROUTE_PREFIXES = new Set([
  "/dashboard/scans",
  "/dashboard/findings",
  "/dashboard/reports",
  "/dashboard/targets",
])

const ENVIRONMENTS = new Set(["production", "development", "test", "preview", "staging"])
const MAX_STACK_FRAMES = 12

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function safeErrorType(value: unknown): string {
  return typeof value === "string" && ERROR_TYPES.has(value) ? value : "Error"
}

function safeRoute(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) return "/other"
  const withoutMethod = value.replace(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, "")
  const pathname = withoutMethod.split(/[?#]/, 1)[0] ?? ""
  if (STATIC_ROUTES.has(pathname)) return pathname

  const parts = pathname.split("/").filter(Boolean)
  const prefix = `/${parts.slice(0, 2).join("/")}`
  const identifier = parts[2]
  if (
    parts.length === 3 &&
    PRIVATE_ROUTE_PREFIXES.has(prefix) &&
    typeof identifier === "string" &&
    /^[A-Za-z0-9_-]{8,64}$/.test(identifier)
  ) {
    return `${prefix}/[id]`
  }
  return "/other"
}

function safeRelease(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(value)
    ? value
    : undefined
}

function safeEnvironment(value: unknown): string | undefined {
  return typeof value === "string" && ENVIRONMENTS.has(value) ? value : undefined
}

function safeFrame(frameValue: unknown): StackFrame | null {
  const frame = record(frameValue)
  if (!frame) return null
  const rawFilename = typeof frame.filename === "string" ? frame.filename : frame.abs_path
  if (typeof rawFilename !== "string") return null
  let path = rawFilename.split(/[?#]/, 1)[0] ?? ""
  if (path.startsWith("webpack-internal:///")) {
    path = path.slice("webpack-internal:///".length)
  } else if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path)
      if (!url.pathname.startsWith("/_next/static/chunks/")) return null
      path = url.pathname
    } catch {
      return null
    }
  }

  path = path.replace(/^\.\//, "")
  if (
    path.includes("/") &&
    !path.startsWith("src/") &&
    !path.startsWith("apps/web/src/") &&
    !path.startsWith("_next/static/chunks/")
  ) {
    return null
  }

  const filename = path.split(/[\\/]/).pop()
  if (!filename || !/^[A-Za-z0-9_.-]{1,80}\.(?:js|mjs|cjs|ts|tsx|jsx)$/.test(filename)) {
    return null
  }

  const sanitized: StackFrame = { filename }
  if (typeof frame.lineno === "number" && Number.isInteger(frame.lineno)) {
    sanitized.lineno = Math.max(0, Math.min(frame.lineno, 1_000_000))
  }
  if (typeof frame.colno === "number" && Number.isInteger(frame.colno)) {
    sanitized.colno = Math.max(0, Math.min(frame.colno, 1_000_000))
  }
  if (typeof frame.in_app === "boolean") sanitized.in_app = frame.in_app
  return sanitized
}

/**
 * Rebuilds a browser error event from a strict allowlist. Unknown routes collapse
 * to `/other`; private route identifiers are replaced with a static placeholder.
 */
export function sanitizeBrowserErrorEvent(
  input: ErrorEvent,
  optionalCollectionAllowed: boolean
): ErrorEvent | null {
  if (!optionalCollectionAllowed || input.type !== undefined) return null

  const originalException = input.exception?.values?.[0]
  const type = safeErrorType(originalException?.type)
  const frames = (originalException?.stacktrace?.frames ?? [])
    .slice(-MAX_STACK_FRAMES)
    .map(safeFrame)
    .filter((frame): frame is StackFrame => frame !== null)

  const result: ErrorEvent = {
    type: undefined,
    level: input.level === "fatal" ? "fatal" : "error",
    platform: "javascript",
    transaction: safeRoute(input.transaction),
    tags: { error_category: type },
    exception: {
      values: [
        {
          type,
          value: type,
          ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
        },
      ],
    },
  }

  const environment = safeEnvironment(input.environment)
  if (environment) result.environment = environment
  const release = safeRelease(input.release)
  if (release) result.release = release
  if (typeof input.timestamp === "number" && Number.isFinite(input.timestamp)) {
    result.timestamp = input.timestamp
  }
  return result
}
