import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { MYRA_COPY } from "@lyrashield/myra"
import { MyraPanel } from "./myra-panel"

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/scans",
}))

describe("MyraPanel shell", () => {
  const html = renderToStaticMarkup(<MyraPanel />)

  it("renders the Ask Myra launcher and the labelled support dialog", () => {
    expect(html).toContain("Ask Myra</button>")
    expect(html).toContain('id="myra-dash-panel"')
    expect(html).toContain('aria-label="Myra support"')
    expect(html).toContain('aria-controls="myra-dash-panel"')
  })

  it("keeps the launcher above mobile navigation and clear of the activity chip", () => {
    // Below lg the WebMCP activity chip is at bottom-32 on the opposite edge.
    expect(html).toContain("bottom-20")
    expect(html).toContain("left-4")
    expect(html).toContain("lg:bottom-6")
  })

  it("is a focus-managed dialog when the sheet opens", () => {
    expect(html).not.toContain("aria-modal")

    // The modal behavior only exists after the launcher opens the sheet, so
    // it is verified at source level: dialog semantics apply only below lg,
    // focus enters on open, Tab/Shift+Tab stay inside, Escape closes, and
    // focus returns to the launcher.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const src = readFileSync(new URL("./myra-panel.tsx", import.meta.url), "utf8")
    expect(src).toContain('role="dialog"')
    expect(src).toContain("aria-modal={isModal || undefined}")
    expect(src).toContain("mobileCloseRef.current?.focus()")
    expect(src).toContain('e.key === "Escape"')
    expect(src).toContain('e.key !== "Tab"')
    expect(src).toContain("last.focus()")
    expect(src).toContain("first.focus()")
    expect(src).toContain("mobileLauncherRef.current?.focus()")
    // Scroll locking follows the actual modal state, so widening an open
    // mobile sheet to lg runs cleanup and restores body scrolling.
    expect(src).toContain("if (!isModal) return")
    expect(src).toContain("}, [isModal, closeMobile])")
    expect(src).not.toContain("}, [mobileOpen, closeMobile])")
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
