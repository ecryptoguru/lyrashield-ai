import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { WebMcpReceiptProvider } from "@/components/webmcp/webmcp-receipt-provider"
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

import { ScansClient } from "./scans-client"

describe("ScansClient initial render", () => {
  it("renders server-provided filters and the empty scan list", () => {
    const html = renderToStaticMarkup(
      <WebMcpReceiptProvider>
        <ScansClient
          principalId="user-1"
          workspaceId="workspace-1"
          targets={[]}
          initialData={[]}
          initialNextCursor={null}
          initialStateFilter="NEEDS_ATTENTION"
        />
      </WebMcpReceiptProvider>
    )

    expect(html).toContain('aria-label="Filter by target"')
    expect(html).toContain('aria-label="Filter by state"')
    expect(html).toContain('value="NEEDS_ATTENTION" selected=""')
    expect(html).toContain("Refresh")
    expect(html).not.toContain("New scan")
  })

  it("explains invalid-target recovery while preserving the selected state on first render", () => {
    const html = renderToStaticMarkup(
      <WebMcpReceiptProvider>
        <ScansClient
          principalId="user-1"
          workspaceId="workspace-1"
          targets={[]}
          initialData={[]}
          initialNextCursor={null}
          initialStateFilter="NEEDS_ATTENTION"
          initialFilterUnavailable
        />
      </WebMcpReceiptProvider>
    )
    expect(html).toContain('value="NEEDS_ATTENTION" selected=""')
    expect(html).toContain('role="status"')
    expect(html).toContain(
      "This target filter is no longer available. Showing all targets with your selected state."
    )
  })

  it("shows a missing target recovery error before opening the composer", () => {
    const html = renderToStaticMarkup(
      <WebMcpReceiptProvider>
        <ScansClient
          principalId="user-1"
          workspaceId="workspace-1"
          targets={[]}
          initialData={[]}
          initialNextCursor={null}
          initialRecoveryUnavailable
        />
      </WebMcpReceiptProvider>
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain("This target is no longer available. Choose another target.")
  })
})
