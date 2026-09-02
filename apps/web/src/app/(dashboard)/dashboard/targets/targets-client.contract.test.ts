import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("manual repository target form", () => {
  // apps/web has no component test harness; preserve the exact-ref UI/request contract here.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = readFileSync(new URL("./targets-client.tsx", import.meta.url), "utf8")

  it("exposes an accessible optional branch or tag input", () => {
    expect(source).toContain('label="Branch or tag (optional)" htmlFor="repo-ref"')
    expect(source).toContain('id="repo-ref-help"')
    expect(source).toContain('aria-describedby="repo-ref-help"')
    expect(source).toContain("exact branch or release")
  })

  it("sends a trimmed exact ref through the existing target request", () => {
    expect(source).toContain(
      "...(repoForm.branch.trim() ? { branch: repoForm.branch.trim() } : {}),"
    )
  })

  it("keeps domain verification and screen-reader fallback cells visible to assistive technology", () => {
    expect(source).toContain("Domain verification")
    expect(source).toContain("Not applicable")
    expect(source).toContain('<th className="sr-only">')
    expect(source).toContain('<td className="sr-only">')
    expect(source).not.toContain('<td className="hidden">')
  })
})
