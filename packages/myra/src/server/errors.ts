import type { MyraError, MyraErrorCode } from "../contracts"

/** Service-layer error carrying a contract error code. */
export class MyraServiceError extends Error {
  readonly code: MyraErrorCode
  constructor(code: MyraErrorCode, message: string) {
    super(message)
    this.name = "MyraServiceError"
    this.code = code
  }
}

export function err(code: MyraErrorCode, message: string): MyraServiceError {
  return new MyraServiceError(code, message)
}

export function toMyraError(e: unknown): MyraError {
  if (e instanceof MyraServiceError) {
    return { code: e.code, message: e.message.slice(0, 500) }
  }
  return { code: "INTERNAL_ERROR", message: "Something went wrong." }
}
