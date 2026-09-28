import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { EmptyState } from "@lyrashield/ui"

describe("EmptyState headings", () => {
  it("uses h2 by default and h3 inside titled sections", () => {
    expect(renderToStaticMarkup(<EmptyState title="No scans" action={null} />)).toContain("<h2")
    expect(
      renderToStaticMarkup(<EmptyState title="No scans" action={null} headingLevel="h3" />)
    ).toContain("<h3")
  })
})
