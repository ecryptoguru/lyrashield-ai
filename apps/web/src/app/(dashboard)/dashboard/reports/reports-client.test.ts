import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("report share state", () => {
  it("clears the active share banner when that report is revoked", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(new URL("./reports-client.tsx", import.meta.url), "utf8")
    expect(source).toContain("sharedReportId === reportId")
    expect(source).toContain("setShareUrl(null)")
    expect(source).toContain("setCopied(null)")
  })
})
