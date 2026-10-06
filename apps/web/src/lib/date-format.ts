type DateInput = Date | string | number

function parseDate(value: DateInput) {
  // JavaScript interprets timezone-less date-times in the host timezone. Treat
  // API-shaped values as UTC so SSR and hydration always resolve one instant.
  if (typeof value !== "string") return new Date(value)
  const timeStart = value.indexOf("T")
  if (timeStart < 0) return new Date(value)
  const time = value.slice(timeStart + 1)
  const hasTimezone =
    time.endsWith("Z") || time.endsWith("z") || time.includes("+") || time.includes("-")
  const utcValue = `${value}Z`
  return new Date(!hasTimezone && Number.isFinite(Date.parse(utcValue)) ? utcValue : value)
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
})

export function formatDate(value: DateInput) {
  return dateFormatter.format(parseDate(value))
}

export function formatDateTime(value: DateInput) {
  return `${formatDate(value)}, ${formatTime(value)}`
}

/** Format a timestamp in the fixed UTC timezone and name that zone for readers. */
export function formatDateTimeUtc(value: DateInput) {
  return `${formatDateTime(value)} UTC`
}

export function formatTime(value: DateInput) {
  return timeFormatter.format(parseDate(value))
}

export function formatTimeUtc(value: DateInput) {
  return `${formatTime(value)} UTC`
}

const localDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
})

const localTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

export function formatLocalDate(value: DateInput) {
  return localDateFormatter.format(parseDate(value))
}

function formatLocalTime(value: DateInput) {
  return localTimeFormatter.format(parseDate(value))
}

export function formatLocalDateTime(value: DateInput) {
  return `${formatLocalDate(value)}, ${formatLocalTime(value)}`
}

export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "—"
  const startMs = new Date(start).getTime()
  const endMs = end ? new Date(end).getTime() : Date.now()
  const diffSec = Math.round((endMs - startMs) / 1000)
  if (diffSec < 60) return `${diffSec}s`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ${diffSec % 60}s`
  return `${Math.floor(diffSec / 3600)}h ${Math.floor((diffSec % 3600) / 60)}m`
}

export function formatAge(value: string): string {
  const ms = Date.now() - new Date(value).getTime()
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}
