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
