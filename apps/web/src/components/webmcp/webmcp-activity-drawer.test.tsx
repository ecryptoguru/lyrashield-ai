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
})
