#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { findMdxHazards } from "./blog-mdx-lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const blogRoot = resolve(here, "../src/content/blog")

const LABELS = {
  "unterminated-code-span": "inline code span is opened and never closed",
  "mdx-expression": "MDX evaluates this as a JavaScript expression",
  "jsx-element": "MDX parses this as a JSX element",
}

function main() {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned content directory.
  const files = readdirSync(blogRoot).filter((name) => name.endsWith(".mdx"))
  const errors = []

  for (const name of files.sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Descendant of the content directory listed above.
    const raw = readFileSync(join(blogRoot, name), "utf8")
    const closing = raw.indexOf("\n---\n", 4)
    const body = closing === -1 ? raw : raw.slice(closing + 5)
    const offset = closing === -1 ? 0 : raw.slice(0, closing + 5).split("\n").length - 1

    for (const hazard of findMdxHazards(body)) {
      const where = `${name}:${hazard.line + offset}:${hazard.column}`
      const detail = hazard.snippet ? ` -- ${hazard.snippet}` : ""
      errors.push(`${where}: ${LABELS[hazard.kind]}${detail}`)
    }
  }

  if (errors.length > 0) {
    console.error(`Blog MDX validation failed (${errors.length} hazards):`)
    for (const error of errors) console.error(`- ${error}`)
    console.error("\nWrap the flagged text in backticks, or close the code span that swallowed it.")
    process.exit(1)
  }

  console.log(`Blog MDX validation passed for ${files.length} articles.`)
}

main()
