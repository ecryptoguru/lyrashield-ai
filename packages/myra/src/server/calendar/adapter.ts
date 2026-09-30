/**
 * Scheduling adapter boundary. The demo-booking workflow only sees this
 * interface; provider transport is replaceable without touching the
 * permission layer. Provider tokens never leave this module.
 */
import { env } from "@lyrashield/config"
import { GoogleCalendarAdapter } from "./google"
import { MockCalendarAdapter } from "./mock"
import type { CalendarAdapter } from "./types"

export {
  CalendarConflictError,
  CalendarTimeoutError,
  type BusyWindow,
  type CalendarAdapter,
  type CalendarEventResult,
  type CalendarEventSpec,
} from "./types"
export { zonedParts, zonedWallToUtc, type ZonedParts } from "./time"

export function getCalendarAdapter(): CalendarAdapter {
  // The schema fails closed in production: when writes are enabled it refuses
  // the mock provider outright, so this branch can never silently book
  // against the in-process fake.
  if (env.MYRA_CALENDAR_PROVIDER === "google") return new GoogleCalendarAdapter()
  return new MockCalendarAdapter()
}
