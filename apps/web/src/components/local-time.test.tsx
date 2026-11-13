import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { LocalTime } from "./local-time"
import { formatDate, formatDateTime } from "@/lib/date-format"

describe("LocalTime", () => {
  const value = "2026-07-14T09:05:06.000Z"

  it("SSR output matches the UTC label so hydration is clean", () => {
    const html = renderToStaticMarkup(createElement(LocalTime, { value }))
    expect(html).toContain(formatDate(value))
  })

  it("withTime SSR output matches the UTC date-time label", () => {
    const html = renderToStaticMarkup(createElement(LocalTime, { value, withTime: true }))
    expect(html).toContain(formatDateTime(value))
  })

  // The zone swap after mount must not change which instant is shown, so the
  // exact UTC form stays reachable from the rendered element.
  it("carries the UTC instant as a title on both forms", () => {
    for (const withTime of [false, true]) {
      const html = renderToStaticMarkup(createElement(LocalTime, { value, withTime }))
      expect(html).toContain(`title="${formatDateTime(value)}"`)
    }
  })
})
