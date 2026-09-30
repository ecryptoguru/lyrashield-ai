import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { CopyButton } from "./copy-button"

describe("CopyButton accessibility", () => {
  it("provides a 44px touch target and a polite status region", () => {
    const markup = renderToStaticMarkup(<CopyButton text="https://example.test/ref" />)

    expect(markup).toMatch(/class="[^"]*min-h-11[^"]*min-w-11[^"]*"/)
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
  })
})
