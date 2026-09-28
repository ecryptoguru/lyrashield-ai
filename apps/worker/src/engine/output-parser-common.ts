import { MAX_INGESTION_ISSUES, MAX_INGESTION_ISSUE_CHARS } from "./engine-output-schema"

const MAX_TEXT_FIELD_LENGTH = 64 * 1024
export const MAX_DB_INTEGER = 2_147_483_647
export const HTTP_EXCHANGE_ID_PATTERN = /^[0-9]{1,128}$/

export function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT_FIELD_LENGTH ? value : undefined
}

/**
 * Bounded sink for explicit evidence-ingestion issues. Issues are capped so a
 * hostile artifact cannot flood scan storage; once full, only a truncation
 * marker is appended.
 */
export function recordIngestionIssue(issues: string[] | undefined, message: string): void {
  if (!issues) return
  if (issues.length >= MAX_INGESTION_ISSUES) {
    if (issues.length === MAX_INGESTION_ISSUES) {
      issues.push(`further ingestion issues truncated after ${MAX_INGESTION_ISSUES} entries`)
    }
    return
  }
  issues.push(
    message.length > MAX_INGESTION_ISSUE_CHARS
      ? `${message.slice(0, MAX_INGESTION_ISSUE_CHARS)}…`
      : message
  )
}
