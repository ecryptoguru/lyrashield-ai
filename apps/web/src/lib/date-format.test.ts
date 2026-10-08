import { describe, expect, it } from "vitest"
import {
  formatAge,
  formatDate,
  formatDateTime,
  formatDateTimeUtc,
  formatDuration,
  formatLocalDate,
  formatLocalDateTime,
  formatTime,
  formatTimeUtc,
} from "./date-format"

describe("deterministic date formatting", () => {
  const value = "2026-07-14T09:05:06.000Z"

  it("uses a fixed locale and UTC timezone for server/client parity", () => {
    expect(formatDate(value)).toBe("Jul 14, 2026 UTC")
    expect(formatDateTime(value)).toBe("Jul 14, 2026, 09:05 UTC")
    expect(formatDateTimeUtc(value)).toBe("Jul 14, 2026, 09:05 UTC")
    expect(formatTime(value)).toBe("09:05")
    expect(formatTimeUtc(value)).toBe("09:05 UTC")
  })

  it("treats timezone-less API date-times as UTC on every host", () => {
    const previousTimezone = process.env.TZ
    process.env.TZ = "America/New_York"
    try {
      expect(formatDateTime("2026-07-14T09:05:06")).toBe("Jul 14, 2026, 09:05 UTC")
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })

  // One convention: every absolute timestamp states its zone, so a reader in a
  // non-UTC zone never has to guess which clock a line used.
  it("names the zone on every absolute formatter, UTC or local", () => {
    const previousTimezone = process.env.TZ
    process.env.TZ = "America/New_York"
    try {
      const zoneSuffix = /(UTC|GMT[+-]\d{1,2}(?::\d{2})?|GMT|[A-Z]{2,5})$/
      expect(formatDate(value)).toMatch(zoneSuffix)
      expect(formatDateTime(value)).toMatch(zoneSuffix)
      expect(formatLocalDate(value)).toMatch(zoneSuffix)
      expect(formatLocalDateTime(value)).toMatch(zoneSuffix)
      // The local form really is a different clock, not a relabelled UTC one.
      expect(formatLocalDate(value)).not.toBe(formatDate(value))
      expect(formatDateTime(value)).toContain("UTC")
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })
})

describe("elapsed time formatting", () => {
  it("keeps scan durations and relative ages readable", () => {
    expect(formatDuration(null, null)).toBe("—")
    expect(formatDuration("2026-07-14T09:05:00Z", "2026-07-14T10:06:00Z")).toBe("1h 1m")
    expect(formatDuration("2026-07-14T09:05:00Z", "2026-07-14T09:06:02Z")).toBe("1m 2s")
    expect(formatAge(new Date(Date.now() - 2 * 3_600_000).toISOString())).toBe("2h")
  })
})
