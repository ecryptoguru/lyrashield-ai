import { describe, expect, it } from "vitest"

import {
  DEAD_URLS,
  findDeadUrls,
  findUnquotedColonScalars,
} from "../../scripts/blog-offline-gates.mjs"

describe("known-dead URL denylist", () => {
  it("flags a dead URL and names its replacement", () => {
    const dead = "https://modelcontextprotocol.io/specification/2025-06-18/specification"

    expect(findDeadUrls(`See [the spec](${dead}).`)).toEqual([dead])
    expect(DEAD_URLS[dead]).toBe("https://modelcontextprotocol.io/specification/2025-06-18")
  })

  it("leaves the live replacement alone", () => {
    // The regression that made this necessary: the live SARIF URL is the dead
    // one plus a trailing segment, so a naive substring match flags both.
    const live =
      "https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file-to-github"

    expect(findDeadUrls(`Upload it via [SARIF](${live}).`)).toEqual([])
  })

  it("still flags the shorter dead SARIF path when it stands alone", () => {
    const dead =
      "https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file"

    expect(findDeadUrls(`Upload it via [SARIF](${dead}).`)).toEqual([dead])
  })

  it("reports nothing for clean copy", () => {
    expect(findDeadUrls("Read [OWASP Top Ten](https://owasp.org/www-project-top-ten/).")).toEqual(
      []
    )
  })

  it("keeps every replacement out of the dead set", () => {
    for (const replacement of Object.values(DEAD_URLS)) {
      expect(Object.keys(DEAD_URLS)).not.toContain(replacement)
    }
  })
})

describe("unquoted frontmatter scalars", () => {
  it("flags an unquoted value containing a colon-space", () => {
    const frontmatter = "title: Clean\ndescription: Set it up step by step: CLI, then config"

    expect(findUnquotedColonScalars(frontmatter)).toEqual([{ key: "description", line: 2 }])
  })

  it("accepts the same value once quoted", () => {
    expect(
      findUnquotedColonScalars('description: "Set it up step by step: CLI, then config"')
    ).toEqual([])
    expect(
      findUnquotedColonScalars("description: 'Set it up step by step: CLI, then config'")
    ).toEqual([])
  })

  it("ignores a plain key and a colon with no following space", () => {
    expect(findUnquotedColonScalars("pubDate: 2026-08-07\nslug: a:b")).toEqual([])
  })

  it("ignores block scalars", () => {
    expect(findUnquotedColonScalars("description: >\n  Step by step: CLI")).toEqual([])
  })
})
