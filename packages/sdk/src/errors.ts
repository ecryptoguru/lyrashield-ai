export interface LyraShieldErrorOptions {
  status: number
  code?: string
  message: string
  retryAfter?: number
}

export class LyraShieldError extends Error {
  status: number
  code?: string
  retryAfter?: number

  constructor({ status, code, message, retryAfter }: LyraShieldErrorOptions) {
    super(message)
    this.name = "LyraShieldError"
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
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
  return value instanceof NotModified || (value as { notModified?: boolean } | null)?.notModified === true
}
