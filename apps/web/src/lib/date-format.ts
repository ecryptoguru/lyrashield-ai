type DateInput = Date | string | number

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
  return dateFormatter.format(new Date(value))
}

export function formatDateTime(value: DateInput) {
  return `${formatDate(value)}, ${formatTime(value)}`
}

export function formatTime(value: DateInput) {
  return timeFormatter.format(new Date(value))
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
  return localDateFormatter.format(new Date(value))
}

export function formatLocalTime(value: DateInput) {
  return localTimeFormatter.format(new Date(value))
}

export function formatLocalDateTime(value: DateInput) {
  return `${formatLocalDate(value)}, ${formatLocalTime(value)}`
}
