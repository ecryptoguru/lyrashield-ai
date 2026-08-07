import { describe, expect, it } from "vitest"

import {
  findMdxHazards,
  partitionCodeSpans,
  stripFencedBlocks,
} from "../../scripts/blog-mdx-lib.mjs"

describe("blog MDX hazards", () => {
  it("ignores fenced code blocks entirely", () => {
    const body = ["```json", '{ "env": { "KEY": "${env:KEY}" } }', "```", "Prose after."].join("\n")

    expect(stripFencedBlocks(body)).toEqual(["", "", "", "Prose after."])
    expect(findMdxHazards(body)).toEqual([])
  })

  it("treats text inside inline code as safe", () => {
    expect(findMdxHazards("Use `${env:VAR}` interpolation, not raw tokens.")).toEqual([])
    expect(findMdxHazards('Set `headers: {Authorization: "Bearer x"}` on the request.')).toEqual([])
  })

  it("flags a brace expression left in prose", () => {
    const hazards = findMdxHazards("Use ${VAR} references and load values from env.")

    expect(hazards).toHaveLength(1)
    expect(hazards[0]).toMatchObject({ kind: "mdx-expression", line: 1 })
  })

  it("flags the unterminated code span and the expression it leaks", () => {
    // The release-1 regression: no closing backtick after the URL, so the later
    // backticks re-pair and the object literal escapes into a live expression.
    const hazards = findMdxHazards(
      'Remote: `url: https://app.lyrashieldai.com/api/mcp, `headers: {Authorization: "x"}`.'
    )

    expect(hazards.map((hazard) => hazard.kind)).toContain("mdx-expression")
  })

  it("pairs backtick runs by length, per CommonMark", () => {
    const { spans, unterminated } = partitionCodeSpans("``a `b` c`` and `d`")

    expect(spans).toHaveLength(2)
    expect(unterminated).toEqual([])
    expect(partitionCodeSpans("`open and never closed").unterminated).toEqual([0])
  })

  it("flags JSX-looking tags but not comparison operators", () => {
    expect(findMdxHazards("Latency stayed <20ms under load.")).toEqual([])
    expect(findMdxHazards("Render a <Callout /> here.").map((h) => h.kind)).toEqual(["jsx-element"])
  })

  it("respects backslash escapes", () => {
    expect(findMdxHazards("A literal \\{not an expression\\} in prose.")).toEqual([])
  })
})
