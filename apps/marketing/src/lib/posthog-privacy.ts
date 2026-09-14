const URL_PROPERTIES = [
  "$current_url",
  "$referrer",
  "$initial_referrer",
  "$session_entry_url",
  "$session_entry_referrer",
  "referrer",
]

export function privacyBoundedMarketingEvent<T extends { properties: Record<string, unknown> }>(
  event: T
): T {
  for (const property of URL_PROPERTIES) {
    const value = event.properties[property]
    if (typeof value !== "string") continue
    try {
      const url = new URL(value)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        delete event.properties[property]
        continue
      }
      event.properties[property] = `${url.origin}${url.pathname}`
    } catch {
      delete event.properties[property]
    }
  }
  return event
}
