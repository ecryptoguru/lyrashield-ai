import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ReportCreateForm } from "./reports-views"

function renderCreateForm(overrides: Partial<React.ComponentProps<typeof ReportCreateForm>> = {}) {
  return renderToStaticMarkup(
    <ReportCreateForm
      reportType="executive"
      onReportTypeChange={vi.fn()}
      reportTitle=""
      onTitleChange={vi.fn()}
      scans={[]}
      scanCursor={null}
      loadingScans={false}
      loadingMoreScans={false}
      scansError={null}
      scanPageError={null}
      linkedScanUnavailable={false}
      scopeValue="workspace"
      onScopeChange={vi.fn()}
      onRetryScans={vi.fn()}
      onLoadMoreScans={vi.fn()}
      creating={false}
      canCreate
      onCreate={vi.fn()}
      onCancel={vi.fn()}
      onUseWorkspaceScope={vi.fn()}
      {...overrides}
    />
  )
}

describe("report creation form", () => {
  it("shows workspace-wide creation as an explicit scope", () => {
    const html = renderCreateForm()

    expect(html).toContain("Report scope")
    expect(html).toContain("All workspace findings")
  })

  it("blocks an unavailable scan and offers an explicit workspace alternative", () => {
    const html = renderCreateForm({
      scopeValue: "scan:missing-scan",
      linkedScanUnavailable: true,
      canCreate: false,
    })

    expect(html).toContain("This linked scan is unavailable")
    expect(html).toContain("Create a workspace report instead")
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Create<\/button>/)
  })
})
