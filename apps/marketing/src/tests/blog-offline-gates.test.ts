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

  it("corrects the OWASP BOLA entry number, not just the path", () => {
    // The dead link pointed at 0xa2; Broken Object Level Authorization is API1
    // in the 2023 edition, so the replacement also fixes a factual error.
    const dead =
      "https://owasp.org/API-Security/editions/2023/en/0xa2-broken-object-level-authorization/"

    expect(findDeadUrls(`See [BOLA](${dead}).`)).toEqual([dead])
    expect(DEAD_URLS[dead]).toContain("0xa1-broken-object-level-authorization")
  })

  it("does not list the Aider MCP URL, which has no equivalent page", () => {
    // Aider ships no native MCP support, so aider-mcp-security-workflow is an
    // editorial question. Listing the URL before that post is resolved would
    // fail the gate on main.
    expect(Object.keys(DEAD_URLS)).not.toContain("https://aider.chat/docs/mcp/mcp.html")
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
