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
    expect(source).toContain('CardTitle as="h2">Open beta</CardTitle>')
    expect(source).toContain("Registration is open")
    expect(source).not.toContain("reply to your invitation email")
  })
})
