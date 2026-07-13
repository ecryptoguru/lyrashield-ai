type DateInput = Date | string | number

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
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
  return dateTimeFormatter.format(new Date(value))
}

export function formatTime(value: DateInput) {
  return timeFormatter.format(new Date(value))
}
