import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("repository connection recovery", () => {
  // apps/web has no component test harness; preserve the rebind contract here.
  const source = readFileSync(
    new URL("./repository-connection-recovery.tsx", import.meta.url),
    "utf8"
  )
  const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")

  it("offers rebinding only to users who may update the target", () => {
    expect(pageSource).toContain("canUpdateTarget && (")
    expect(pageSource).toContain("<RepositoryConnectionRecovery")
  })

  it("lists only active GitHub integrations of the same workspace", () => {
    expect(pageSource).toContain('type: "GITHUB", status: "active", deletedAt: null')
    expect(pageSource).toContain("withWorkspaceRLS(workspaceId")
  })

  it("sends the chosen installation through the workspace-scoped PATCH route", () => {
    expect(source).toContain(
      "apiPatch(`/api/targets/${targetId}`, { workspaceId, installationId: selected })"
    )
  })

  it("points at the connection flow when the workspace has no GitHub integration", () => {
    expect(source).toContain('href="/dashboard/integrations"')
    expect(source).toContain("connections.length === 0")
  })

  it("exposes accessible selection and status", () => {
    expect(source).toContain('aria-live="polite"')
    expect(source).toContain('aria-describedby="target-github-connection-help')
  })
})
