#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parseArticle } from "./blog-validation-lib.mjs"
import { validateCompareProgram, validateComparePage } from "./compare-validation-lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const contentRoot = resolve(here, "../src/content")
const compareRoot = join(contentRoot, "compare")

const read = (path) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned content paths.
  readFileSync(path, "utf8")

function main() {
  const program = JSON.parse(read(join(contentRoot, "compare-program.json")))
  const errors = validateCompareProgram(program)

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned content directory.
  const files = readdirSync(compareRoot).filter((name) => /\.mdx?$/.test(name))
  const bySlug = new Map(files.map((name) => [name.replace(/\.mdx?$/, ""), name]))

  for (const entry of program) {
    if (!bySlug.has(entry.slug)) errors.push(`missing comparison page: ${entry.slug}`)
  }
  for (const slug of bySlug.keys()) {
    if (!program.some((entry) => entry.slug === slug)) {
      errors.push(`unmapped comparison page: ${slug}`)
    }
  }

  const publishedBlogSlugs = new Set(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned content directory.
    readdirSync(join(contentRoot, "blog"))
      .filter((name) => /\.mdx?$/.test(name))
      .map((name) => name.replace(/\.mdx?$/, ""))
  )

  const pages = []
  for (const [slug, name] of bySlug) {
    try {
      pages.push({ slug, ...parseArticle(read(join(compareRoot, name))) })
    } catch (error) {
      errors.push(`${slug}: ${error.message}`)
    }
  }

  const tally = (values) =>
    new Map(values.map((value) => [value, values.filter((other) => other === value).length]))
  const titles = tally(pages.map((page) => page.data.title))
  const descriptions = tally(pages.map((page) => page.data.description))

  for (const page of pages) {
    const programEntry = program.find((entry) => entry.slug === page.slug)
    const pageErrors = validateComparePage({
      slug: page.slug,
      data: page.data,
      body: page.body,
      programEntry,
      context: { titles, descriptions, publishedBlogSlugs },
    })
    for (const error of pageErrors) errors.push(`${page.slug}: ${error}`)
  }

  const unique = [...new Set(errors)]
  if (unique.length > 0) {
    console.error(`Compare content validation failed (${unique.length} violations):`)
    for (const error of unique) console.error(`- ${error}`)
    process.exit(1)
  }

  console.log(`Compare content validation passed for ${pages.length} comparisons.`)
}

main()
