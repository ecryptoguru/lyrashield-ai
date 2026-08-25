import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("repository ref editor", () => {
  // apps/web has no component test harness; preserve the zero-scan editor contract here.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = readFileSync(new URL("./repository-ref-editor.tsx", import.meta.url), "utf8")
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")

  it("renders only for authorized REPO targets with zero scans", () => {
    expect(pageSource).toContain("hasPermission(membership.role, PERMISSIONS.target.update)")
    expect(pageSource).toContain("target._count.scans === 0 && canUpdateTarget")
  })

  it("sends a trimmed ref through the workspace-scoped target PATCH route", () => {
    expect(source).toContain(
      "apiPatch(`/api/targets/${targetId}`, { workspaceId, branch: trimmedRef })"
    )
  })

  it("explains immutability and exposes accessible save status", () => {
    expect(source).toContain("It becomes immutable after")
    expect(source).toContain('aria-live="polite"')
    expect(source).toContain('aria-describedby="repository-ref-help repository-ref-status"')
  })
})
