import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { LoadingShell, LoadingShellHeader } from "./loading-shell"

describe("LoadingShell", () => {
  it("renders one polite live region labelled by an sr-only heading", () => {
    const html = renderToStaticMarkup(
      createElement(LoadingShell, { label: "Loading billing" }, createElement("div"))
    )
    expect(html).toBe(
      '<div role="status" aria-live="polite" aria-busy="true" aria-label="Loading billing">' +
        '<h1 class="sr-only">Loading billing</h1><div></div></div>'
    )
  })

  it("defaults to the shared 'Loading page' label", () => {
    const html = renderToStaticMarkup(createElement(LoadingShell))
    expect(html).toContain('aria-label="Loading page"')
    expect(html).toContain('<h1 class="sr-only">Loading page</h1>')
  })

  it("omits the class attribute when no className is given", () => {
    const html = renderToStaticMarkup(createElement(LoadingShell))
    expect(html).toMatch(/^<div role="status"/)
  })

  it("applies className to the status wrapper", () => {
    const html = renderToStaticMarkup(
      createElement(LoadingShell, { className: "min-w-0 space-y-6" })
    )
    expect(html).toContain('class="min-w-0 space-y-6"')
  })
})

describe("LoadingShellHeader", () => {
  it("renders the detail variant: eyebrow, wide title, subtitle", () => {
    const html = renderToStaticMarkup(createElement(LoadingShellHeader))
    expect(html).toContain('<div class="space-y-3">')
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(3)
    expect(html).toContain("h-3 w-28")
    expect(html).toContain("h-9 w-72")
    expect(html).toContain("h-4 w-96")
  })

  it("renders the title variant: shorter title plus subtitle", () => {
    const html = renderToStaticMarkup(createElement(LoadingShellHeader, { variant: "title" }))
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(2)
    expect(html).toContain("h-8 w-40")
    expect(html).toContain("h-4 w-96")
    expect(html).not.toContain("h-3 w-28")
  })

  it("accepts a wrapper className override", () => {
    const html = renderToStaticMarkup(
      createElement(LoadingShellHeader, { variant: "title", className: "mb-6 space-y-3" })
    )
    expect(html).toContain('class="mb-6 space-y-3"')
  })
})
