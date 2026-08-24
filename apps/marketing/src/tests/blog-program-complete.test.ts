import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import program from "../content/blog-program.json"
import { PROGRAM_ARTICLE_COUNT, parseArticle } from "../../scripts/blog-validation-lib.mjs"

describe("complete blog program", () => {
  it("has exactly the mapped public articles", () => {
    const blogDirectory = resolve(import.meta.dirname, "../content/blog")
    const published = readdirSync(blogDirectory)
      .filter((file) => file.endsWith(".mdx"))
      .map((file) => ({
        id: file.replace(/\.mdx$/, ""),
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- The file name is enumerated from the repository-owned blog content directory above.
        data: parseArticle(readFileSync(resolve(blogDirectory, file), "utf8")).data as {
          draft?: boolean
        },
      }))
      .filter((post) => post.data.draft === false)

    expect(published).toHaveLength(PROGRAM_ARTICLE_COUNT)
    expect(new Set(published.map((post) => post.id))).toEqual(
      new Set(program.map((entry) => entry.slug))
    )
  })
})
