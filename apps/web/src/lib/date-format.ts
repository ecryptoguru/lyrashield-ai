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

export function formatTime(value: DateInput) {
  return timeFormatter.format(parseDate(value))
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

export function formatLocalTime(value: DateInput) {
  return localTimeFormatter.format(parseDate(value))
}

export function formatLocalDateTime(value: DateInput) {
  return `${formatLocalDate(value)}, ${formatLocalTime(value)}`
}
