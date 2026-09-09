import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("settings account-deletion access", () => {
  // apps/web has no component-test harness; preserve the server-rendered path contract here.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")

  it("renders the reviewed deletion request path even when the user has no workspace", () => {
    const noWorkspacePath = source.match(/if \(!workspaceId\) \{[\s\S]*?\n  \}/)?.[0]
    expect(noWorkspacePath).toContain("<DeleteAccount />")
    expect(source).not.toContain("getAccountDeletionPlan")
  })

  it("describes the actual open-registration beta", () => {
    // W2-11: the open-beta notice describes the workspace service, so it
    // lives on the workspace settings page; account deletion stays personal.
    expect(source).not.toContain("reply to your invitation email")
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const workspaceSource = readFileSync(new URL("./workspace/page.tsx", import.meta.url), "utf8")
    expect(workspaceSource + source).toContain("Registration is open")
  })
})
