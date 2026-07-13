import { describe, expect, it } from "vitest"
import { formatDate, formatDateTime, formatTime } from "./date-format"

describe("deterministic date formatting", () => {
  const value = "2026-07-14T09:05:06.000Z"

  it("uses a fixed locale and UTC timezone for server/client parity", () => {
    expect(formatDate(value)).toBe("Jul 14, 2026")
    expect(formatDateTime(value)).toBe("Jul 14, 2026, 09:05")
    expect(formatTime(value)).toBe("09:05")
  })
})
