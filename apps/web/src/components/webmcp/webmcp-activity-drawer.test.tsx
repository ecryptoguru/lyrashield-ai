import { readFileSync } from "node:fs"
import { describe, expect, it, vi, afterAll } from "vitest"
import { renderToString } from "react-dom/server"
import { WebMcpReceiptProvider, useWebMcpReceiptStore } from "./webmcp-receipt-provider"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).window = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window
})

function Consumer() {
  const store = useWebMcpReceiptStore()
  store.add({
    toolName: "test_tool",
    classification: "read",
    status: "completed",
    dataClass: "workspace-summary",
    untrustedContent: false,
    uiChanged: false,
    durableMutation: false,
    humanConfirmationRequired: false,
    summary: "Test completed",
    references: { scanId: "scan-1" },
    href: "/dashboard/scans/scan-1",
  })
  return <div data-testid="consumer">consumer</div>
}

describe("WebMcpActivityDrawer", () => {
  it("renders the receipt provider and a completed receipt chip", () => {
    const html = renderToString(
      <WebMcpReceiptProvider>
        <Consumer />
      </WebMcpReceiptProvider>
    )
    expect(html).toContain("Agent activity")
    expect(html).toContain("test_tool")
    expect(html).toContain("Done")
  })

  it("renders the receipt recovery link only for sanitized in-dashboard hrefs", () => {
    // The expanded panel only mounts on interaction, so the link markup lives
    // in source: it is conditional on `receipt.href`, which only ever holds a
    // sanitized `/dashboard/...` path (see safeDashboardHref).
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const src = readFileSync(new URL("./webmcp-activity-drawer.tsx", import.meta.url), "utf8")
    expect(src).toContain("receipt.href")
    expect(src).toContain("href={receipt.href}")
    expect(src).toContain("Open in dashboard")
  })

  it("stacks above the Myra Help launcher instead of sharing its band", () => {
    // F5 regression: below lg the chip and Help both sat at bottom-20, and the
    // chip's higher z-index made Help unclickable at ~768px. The chip now
    // occupies bottom-32 (above Help) and only drops to bottom-6 at lg where
    // Help is hidden — bottom-20 must not appear anywhere in this stack.
    const html = renderToString(
      <WebMcpReceiptProvider>
        <Consumer />
      </WebMcpReceiptProvider>
    )
    expect(html).toContain("bottom-32")
    expect(html).toContain("lg:bottom-6")
    expect(html).not.toContain("bottom-20")

    // The expanded panel only mounts on interaction, so its class lives in
    // source: it must clear the raised chip (bottom-32 + chip height + gap).
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const src = readFileSync(new URL("./webmcp-activity-drawer.tsx", import.meta.url), "utf8")
    expect(src).toContain("bottom-44")
  })
})
