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
})
