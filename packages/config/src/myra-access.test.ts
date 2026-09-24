import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { myraDashboardAllowed } from "./myra-access"

describe("Myra dashboard admission", () => {
  it("gates the dashboard on a verified email", () => {
    expect(myraDashboardAllowed({ emailVerified: true })).toBe(true)
    expect(myraDashboardAllowed({ emailVerified: false })).toBe(false)
  })

  it("is the single gate shared by the dashboard layout and the API principal gate", () => {
    const read = (path: string) =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      readFileSync(new URL(path, import.meta.url), "utf8")
    const layout = read("../../../apps/web/src/app/(dashboard)/layout.tsx")
    const lib = read("../../../apps/web/src/app/api/myra/_lib.ts")
    // The UI mount and the API gate must not drift into two rules again.
    expect(layout).toContain("myraDashboardAllowed")
    expect(layout).toContain("emailVerified")
    expect(lib).toContain("myraDashboardAllowed")
  })

  it("leaves no allowlist plumbing in the schema, examples or the deploy wiring", () => {
    const read = (path: string) =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      readFileSync(new URL(path, import.meta.url), "utf8")
    const files = [
      "../env.ts",
      "../../../.env.example",
      "../../../apps/web/.env.example",
      "../../../.github/scripts/verify-myra-deployment-config.mjs",
      "../../../.github/workflows/deploy-azure.yml",
      "../../../apps/web/src/app/(dashboard)/layout.tsx",
      "../../../apps/web/src/app/api/myra/_lib.ts",
      "./index.ts",
    ]
    for (const file of files) {
      expect(read(file), `${file} must not reference MYRA_ALLOWED_EMAILS`).not.toContain(
        "MYRA_ALLOWED_EMAILS"
      )
      expect(read(file), `${file} must not reference isMyraAllowedEmail`).not.toContain(
        "isMyraAllowedEmail"
      )
    }
  })
})
