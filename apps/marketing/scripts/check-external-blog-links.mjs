#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { checkExternalLinks, extractLinks, parseArticle } from "./blog-validation-lib.mjs"

const marketingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const releases = ["authority", "batch-1", "batch-2", "batch-3", "batch-4", "batch-5", "batch-6"]

function releaseArgument() {
  const index = process.argv.indexOf("--release")
  return index === -1 ? "all" : process.argv[index + 1]
}

async function main() {
  const release = releaseArgument()
  if (!release || (release !== "all" && !releases.includes(release))) {
    console.error(`Blog external-link check failed: unknown release ${release ?? "missing"}.`)
    process.exitCode = 1
    return
  }

  let program
  try {
    program = JSON.parse(readFileSync(join(marketingRoot, "src/content/blog-program.json"), "utf8"))
  } catch (error) {
    console.error(
      `Blog external-link check failed: blog program could not be read: ${error.message}`
    )
    process.exitCode = 1
    return
  }

  const entries = program.filter((entry) => release === "all" || entry.batch === release)
  const articles = []
  const errors = []
  for (const entry of entries) {
    const markdown = join(marketingRoot, "src/content/blog", `${entry.slug}.md`)
    const mdx = join(marketingRoot, "src/content/blog", `${entry.slug}.mdx`)
    const path = existsSync(markdown) ? markdown : existsSync(mdx) ? mdx : null
    if (!path) {
      errors.push(`${entry.slug}: article is missing`)
      continue
    }
    try {
      const { body } = parseArticle(readFileSync(path, "utf8"))
      articles.push({
        slug: entry.slug,
        urls: extractLinks(body).filter((url) => /^https?:\/\//i.test(url)),
      })
    } catch (error) {
      errors.push(`${entry.slug}: ${error.message}`)
    }
  }

  errors.push(...(await checkExternalLinks(articles)))
  if (errors.length > 0) {
    console.error(`Blog external-link check failed for ${release} (${errors.length} violations):`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
  } else {
    console.log(`Blog external-link check passed for ${release}.`)
  }
}

await main()
