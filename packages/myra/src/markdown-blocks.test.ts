import { describe, expect, it } from "vitest"
import { parseMyraMarkdownBlocks } from "./markdown-blocks"

describe("parseMyraMarkdownBlocks", () => {
  it("preserves paragraph → list → fenced code → paragraph order", () => {
    const blocks = parseMyraMarkdownBlocks(
      ["intro line", "- first", "- second", "```ts", "const x = 1", "```", "closing line"].join(
        "\n"
      )
    )
    expect(blocks).toEqual([
      { type: "paragraph", lines: ["intro line"] },
      { type: "list", items: ["first", "second"] },
      { type: "code", text: "const x = 1" },
      { type: "paragraph", lines: ["closing line"] },
    ])
  })

  it("groups ordered and Unicode bullets into one adjacent list", () => {
    const blocks = parseMyraMarkdownBlocks(
      ["• alpha", "* beta", "12. gamma", "3) delta", "- epsilon"].join("\n")
    )
    expect(blocks).toEqual([
      { type: "list", items: ["alpha", "beta", "gamma", "delta", "epsilon"] },
    ])
  })

  it("preserves raw whitespace and newlines inside fenced code", () => {
    const blocks = parseMyraMarkdownBlocks("```\n  indented\n\n\tconst y = 2\n```")
    expect(blocks).toEqual([{ type: "code", text: "  indented\n\n\tconst y = 2" }])
  })

  it("emits an unclosed nonempty fence at EOF", () => {
    const blocks = parseMyraMarkdownBlocks("before\n```\ntail line")
    expect(blocks).toEqual([
      { type: "paragraph", lines: ["before"] },
      { type: "code", text: "tail line" },
    ])
  })

  it("omits empty fenced blocks", () => {
    const blocks = parseMyraMarkdownBlocks("a\n```\n```\nb")
    expect(blocks).toEqual([
      { type: "paragraph", lines: ["a"] },
      { type: "paragraph", lines: ["b"] },
    ])
  })

  it("splits paragraphs on blank lines and joins adjacent lines", () => {
    const blocks = parseMyraMarkdownBlocks("line one\nline two\n\nline three")
    expect(blocks).toEqual([
      { type: "paragraph", lines: ["line one", "line two"] },
      { type: "paragraph", lines: ["line three"] },
    ])
  })
})
