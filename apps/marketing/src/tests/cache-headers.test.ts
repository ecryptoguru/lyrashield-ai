import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const CACHE_VALUE = "public, max-age=3600"

describe("SSRS text endpoints send a cacheable Cache-Control", () => {
  it("llms.txt sets Cache-Control on its success response", () => {
    const llms = source("../pages/llms.txt.ts")
    // Header must live on the Response headers object, not a comment.
    expect(llms).toMatch(
      /new Response\([\s\S]*?headers:\s*{[\s\S]*?"Cache-Control":\s*"public, max-age=3600"/
    )
    expect(llms).not.toContain("max-age=31536000")
  })

  it("rss.xml sets Cache-Control on the rss() response", () => {
    const rss = source("../pages/rss.xml.ts")
    expect(rss).toContain(`headers.set("Cache-Control", "${CACHE_VALUE}")`)
  })
})
