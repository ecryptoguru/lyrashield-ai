import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The screen spans its keyed route boundary, coordinator, and presentational views.
function screenSource(): string {
  return (
    ["page.tsx", "reports-client.tsx", "reports-views.tsx"]
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

describe("report creation scope and async state", () => {
  it("keeps unavailable scan links selected until an explicit workspace choice", () => {
    const source = screenSource()
    expect(source).toContain('initialScanId ? { kind: "scan", scanId: initialScanId }')
    expect(source).toContain("const linkedScanUnavailable =")
    expect(source).toContain(
      'const canCreate = creationScope.kind === "workspace" || selectedScanAvailable'
    )
    expect(source).toContain("Create a workspace report instead")
    expect(source).toContain(
      '...(creationScope.kind === "scan" ? { scanId: creationScope.scanId } : {})'
    )
  })

  it("keeps history workspace-wide and ignores stale pagination and mutation responses", () => {
    const source = screenSource()
    expect(source).toContain("Workspace report history")
    expect(source).toContain("Shows every report in this workspace")
    expect(source).toContain("{ workspaceId, cursor }")
    expect(source).toContain("createRequestsRef.current.has(requestScope)")
    expect(source).toContain(
      "reportMutationVersionsRef.current.get(mutationKey) !== mutationVersion"
    )
    expect(source).toContain("isWorkspaceCurrent(workspaceId)")
    expect(source).toContain("mountedRef.current = false")
    expect(source).toContain("key={`${session.userId}:${workspaceId}:")
  })
})
