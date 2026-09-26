export interface LyraShieldErrorOptions {
  status: number
  code?: string
  message: string
  retryAfter?: number
  /**
   * Opaque server-supplied error details (e.g. `operationId` on idempotent
   * replay conflicts) — carried verbatim for programmatic recovery.
   */
  details?: Record<string, unknown>
}

export class LyraShieldError extends Error {
  status: number
  code?: string
  retryAfter?: number
  details?: Record<string, unknown>

  constructor({ status, code, message, retryAfter, details }: LyraShieldErrorOptions) {
    super(message)
    this.name = "LyraShieldError"
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
    this.details = details
  }

  get isScanConcurrencyLimit(): boolean {
    return this.code === "SCAN_CONCURRENCY_LIMIT"
  }

  get isScanRateLimited(): boolean {
    return this.code === "SCAN_RATE_LIMITED"
  }

  get isRetestInProgress(): boolean {
    return this.code === "RETEST_IN_PROGRESS"
  }
}

export class NotModified {
  readonly notModified = true
  readonly etag?: string

  constructor(etag?: string) {
    this.etag = etag
  }
}

export function isNotModified(value: unknown): value is NotModified {
  return (
    value instanceof NotModified ||
    (value as { notModified?: boolean } | null)?.notModified === true
  )
}
