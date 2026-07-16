import { describe, expect, it } from "vitest"
import program from "../content/blog-program.json"
import images from "../content/blog-images/images.json"
import authors from "../content/authors/authors.json"

describe("blog program contracts", () => {
  it("contains the exact ordered 100-topic program", () => {
    expect(program).toHaveLength(100)
    expect(program[0]).toMatchObject({
      index: 1,
      slug: "vibe-coding-security-guide",
      batch: "authority",
    })
    expect(program[99]).toMatchObject({
      index: 100,
      slug: "exposed-api-key-incident-response",
      batch: "batch-6",
    })
    expect(new Set(program.map((entry) => entry.slug)).size).toBe(100)
  })

  it("starts with an empty typed image catalog", () => {
    expect(images).toEqual({})
  })

  it("declares LyraShield Team as an organization", () => {
    expect(authors["lyrashield-team"].kind).toBe("Organization")
  })
})
