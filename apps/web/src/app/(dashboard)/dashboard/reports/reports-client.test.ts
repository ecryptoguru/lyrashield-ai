import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The screen is split across a coordinator (reports-client.tsx) and
// presentational views (reports-views.tsx); contract greps read both.
function screenSource(): string {
  return (
    ["reports-client.tsx", "reports-views.tsx"]
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      .map((file) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8"))
      .join("\n")
  )
}

describe("report share state", () => {
  it("clears the active share banner when that report is revoked", () => {
    const source = screenSource()
    expect(source).toContain("sharedReportId === reportId")
    expect(source).toContain("setShareUrl(null)")
    expect(source).toContain("setCopied(null)")
  })

  it("uses separate inline-view and attachment download URLs", () => {
    const source = screenSource()
    expect(source).toContain(
      "href={`/api/reports/${report.id}/download?workspaceId=${workspaceId}`}"
    )
    expect(source).toContain(
      "href={`/api/reports/${report.id}/download?workspaceId=${workspaceId}&download=1`}"
    )
  })
})
