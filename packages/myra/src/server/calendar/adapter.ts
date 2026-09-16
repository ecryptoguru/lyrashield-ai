/**
 * Scheduling adapter boundary. The demo-booking workflow only sees this
 * interface; provider transport is replaceable without touching the
 * permission layer. Provider tokens never leave this module.
 */
import { MyraServiceError } from "../errors"
import { GoogleCalendarAdapter } from "./google"
import { MockCalendarAdapter } from "./mock"

export interface BusyWindow {
  start: Date
  end: Date
}

export interface CalendarEventSpec {
  /** Deterministic provider event id — retries reuse it, never duplicate. */
  eventId: string
  summary: string
  description?: string
  start: Date
  end: Date
  attendeeEmail: string
  attendeeName: string
  organizerEmail: string
  /** Unique conference request id tied to the booking. */
  conferenceRequestId: string
  requestMeet: boolean
}

export interface CalendarEventResult {
  eventId: string
  meetLink: string | null
  /** none | pending | ready | failed — tracked separately from event state. */
  conferenceState: string
}

export interface CalendarAdapter {
  name: string
  listBusy(from: Date, to: Date): Promise<BusyWindow[]>
  insertEvent(spec: CalendarEventSpec): Promise<CalendarEventResult>
  cancelEvent(eventId: string): Promise<void>
  getEvent(eventId: string): Promise<CalendarEventResult | null>
}

/** Thrown when the provider may have accepted the write but the response was lost. */
export class CalendarTimeoutError extends Error {
  constructor(message = "Calendar request timed out") {
    super(message)
    this.name = "CalendarTimeoutError"
  }
}

/** Thrown when the provider reports the slot is no longer free. */
export class CalendarConflictError extends Error {
  constructor(message = "Calendar slot unavailable") {
    super(message)
    this.name = "CalendarConflictError"
  }
}

export function calendarNotConfigured(): MyraServiceError {
  return new MyraServiceError("CALENDAR_NOT_CONFIGURED", "Calendar is not configured.")
}

// ─── Timezone helpers (no tz dependency — Intl only) ──────────────────────

const partsCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      weekday: "short",
    })
    partsCache.set(tz, f)
  }
  return f
}

export interface ZonedParts {
  date: string // YYYY-MM-DD
  weekday: string // Mon..Sun
  minutes: number // minutes since local midnight
}

export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(instant)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  const hour = get("hour") === "24" ? "00" : get("hour")
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    minutes: Number(hour) * 60 + Number(get("minute")),
  }
}

/** Convert a wall-clock time in `tz` to the corresponding UTC instant. */
export function zonedWallToUtc(date: string, minutes: number, tz: string): Date {
  let guess = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000
  const target = guess
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz)
    const wall = Date.parse(`${p.date}T00:00:00Z`) + p.minutes * 60_000
    const diff = target - wall
    if (diff === 0) break
    guess += diff
  }
  return new Date(guess)
}

export function getCalendarAdapter(): CalendarAdapter {
  const provider = (process.env.MYRA_CALENDAR_PROVIDER ?? "mock").toLowerCase()
  if (provider === "google") return new GoogleCalendarAdapter()
  return new MockCalendarAdapter()
}
