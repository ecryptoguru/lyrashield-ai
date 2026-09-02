const MAX_ERROR_MESSAGE_LENGTH = 500

export function safeApiErrorMessage(message: unknown): string {
  if (typeof message !== "string") return "Unknown error"
  const sanitized = message.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()
  if (!sanitized) return "Unknown error"
  return sanitized.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : sanitized
}
