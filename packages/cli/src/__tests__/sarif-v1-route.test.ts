import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The CLI posts SARIF through /api/v1; keep that path wired to the real handler.
// Read the route source so this contract test never initializes app auth or a DB.
describe("CLI SARIF import route", () => {
  it("exports the handler through the v1 API route", () => {
    // Fixed repository paths; no caller input reaches the filesystem.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const route = readFileSync(
      new URL(
        "../../../../apps/web/src/app/api/v1/scans/[id]/artifacts/sarif/route.ts",
        import.meta.url
      ),
      "utf8"
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const handler = readFileSync(
      new URL(
        "../../../../apps/web/src/app/api/scans/[id]/artifacts/sarif/route.ts",
        import.meta.url
      ),
      "utf8"
    )
    expect(route).toContain(
      'export { POST } from "../../../../../scans/[id]/artifacts/sarif/route"'
    )
    expect(handler).toContain("export const POST = withCookieMutation(post)")
  })
})
