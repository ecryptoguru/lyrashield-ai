import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import program from "../content/blog-program.json"
import { parseArticle } from "../../scripts/blog-validation-lib.mjs"

describe("complete blog program", () => {
  it("has exactly the mapped 100 public articles", () => {
    const blogDirectory = resolve(import.meta.dirname, "../content/blog")
    const published = readdirSync(blogDirectory)
      .filter((file) => file.endsWith(".mdx"))
      .map((file) => ({
        id: file.replace(/\.mdx$/, ""),
        data: parseArticle(readFileSync(resolve(blogDirectory, file), "utf8")).data,
      }))
      .filter((post) => post.data.draft === false)

    expect(published).toHaveLength(100)
    expect(new Set(published.map((post) => post.id))).toEqual(
      new Set(program.map((entry) => entry.slug))
    )
  })
})
