import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { MYRA_COPY } from "@lyrashield/myra"
import { MyraPanel } from "./myra-panel"

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/scans",
}))

describe("MyraPanel shell", () => {
  const html = renderToStaticMarkup(<MyraPanel />)

  it("renders the mobile Help launcher and the labelled panel aside", () => {
    expect(html).toContain(">Help</button>")
    expect(html).toContain('id="myra-dash-panel"')
    expect(html).toContain('aria-label="Myra support"')
    expect(html).toContain('aria-controls="myra-dash-panel"')
  })

  it("renders the header, log region, opener, and starter buttons", () => {
    expect(html).toContain(MYRA_COPY.header)
    expect(html).toContain('role="log"')
    expect(html).toContain('aria-label="Conversation with Myra"')
    expect(html).toContain("AI support agent. I can explain the product")
    expect(html).toContain("Help with this page")
    expect(html).toContain("Check setup")
    expect(html).toContain("Understand this result")
  })

  it("renders the composer textarea, Send button, and polite status region", () => {
    expect(html).toContain('id="myra-dash-input"')
    expect(html).toContain(">Send</button>")
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })
})
