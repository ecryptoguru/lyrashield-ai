/**
 * Deterministic in-process calendar adapter — the default. It supplies fixed
 * busy windows and keeps inserted events in a module map so timeout
 * reconciliation (`getEvent` by deterministic event id) is testable.
 *
 * Failure-injection knobs (validated env snapshot — enabled switches are
 * rejected outright in production by the config refinement):
 * - MYRA_MOCK_CALENDAR_TIMEOUT_ON_INSERT=1 — store the event, then throw
 *   CalendarTimeoutError (models "accepted but response lost").
 * - MYRA_MOCK_CALENDAR_PENDING_CONFERENCE=1 — conferenceState stays "pending".
 * - MYRA_MOCK_CALENDAR_EXTERNAL_CONFLICT=1 — insertEvent throws
 *   CalendarConflictError (an external writer took the slot).
 */
import { env } from "@lyrashield/config"
import { MYRA_LIMITS } from "../../contracts"
import {
  CalendarConflictError,
  CalendarTimeoutError,
  zonedWallToUtc,
  type BusyWindow,
  type CalendarAdapter,
  type CalendarEventResult,
  type CalendarEventSpec,
} from "./adapter"

interface StoredEvent extends CalendarEventResult {
  spec: CalendarEventSpec
  canceled: boolean
}

const events = new Map<string, StoredEvent>()

export class MockCalendarAdapter implements CalendarAdapter {
  name = "mock"

  /**
   * Deterministic busy window: 17:00–17:45 host time every weekday —
   * exercise overlap/buffer logic without env state.
   */
  async listBusy(from: Date, to: Date): Promise<BusyWindow[]> {
    const windows: BusyWindow[] = []
    const dayMs = 24 * 60 * 60 * 1000
    for (let t = from.getTime() - dayMs; t <= to.getTime() + dayMs; t += dayMs) {
      const date = new Date(t).toISOString().slice(0, 10)
      const start = zonedWallToUtc(date, 17 * 60, MYRA_LIMITS.demo.hostTimezone)
      const end = zonedWallToUtc(date, 17 * 60 + 45, MYRA_LIMITS.demo.hostTimezone)
      if (end > from && start < to) windows.push({ start, end })
    }
    for (const ev of events.values()) {
      if (!ev.canceled && ev.spec.end > from && ev.spec.start < to) {
        windows.push({ start: ev.spec.start, end: ev.spec.end })
      }
    }
    return windows
  }

  async insertEvent(spec: CalendarEventSpec): Promise<CalendarEventResult> {
    if (env.MYRA_MOCK_CALENDAR_EXTERNAL_CONFLICT === "1") {
      throw new CalendarConflictError()
    }
    const pending = env.MYRA_MOCK_CALENDAR_PENDING_CONFERENCE === "1"
    const result: StoredEvent = {
      eventId: spec.eventId,
      meetLink:
        spec.requestMeet && !pending
          ? `https://meet.google.com/mock-${spec.eventId.slice(-10)}`
          : null,
      conferenceState: spec.requestMeet ? (pending ? "pending" : "ready") : "none",
      spec,
      canceled: false,
    }
    events.set(spec.eventId, result)
    if (env.MYRA_MOCK_CALENDAR_TIMEOUT_ON_INSERT === "1") {
      throw new CalendarTimeoutError()
    }
    return result
  }

  async cancelEvent(eventId: string): Promise<void> {
    const ev = events.get(eventId)
    if (ev) ev.canceled = true
  }

  async getEvent(eventId: string): Promise<CalendarEventResult | null> {
    const ev = events.get(eventId)
    if (!ev || ev.canceled) return null
    return { eventId: ev.eventId, meetLink: ev.meetLink, conferenceState: ev.conferenceState }
  }

  /** Test hook: clear all in-memory events. */
  reset(): void {
    events.clear()
  }
}
