#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  checkExternalLinks,
  extractExternalSourceLinks,
  parseArticle,
  validateProgramRoot,
} from "./blog-validation-lib.mjs"

const marketingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const releases = [
  "authority",
  "batch-1",
  "batch-2",
  "batch-3",
  "batch-4",
  "batch-5",
  "batch-6",
  "batch-7",
  "batch-8",
  "batch-9",
  "batch-10",
  "batch-11",
]
// Page-level citations live outside the blog program, so they are checked on
// every run rather than per release.
const pageCitations = ["src/pages/methodology.astro", "src/pages/ai-safety.astro"]

function extractPageExternalLinks(source) {
  const urls = []
  for (const match of source.matchAll(/href="(https:\/\/[^"]+)"/g)) urls.push(match[1])
  return urls
}

function releaseArgument() {
  const index = process.argv.indexOf("--release")
  if (index === -1) return { value: "all" }
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    return { error: "--release requires a value" }
  }
  return { value: process.argv[index + 1] }
}

async function main() {
  const parsedRelease = releaseArgument()
  if (parsedRelease.error) {
    console.error(`Blog external-link check failed: ${parsedRelease.error}.`)
    process.exitCode = 1
    return
  }
  const release = parsedRelease.value
  if (release !== "all" && !releases.includes(release)) {
    console.error(`Blog external-link check failed: unknown release ${release}.`)
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

  const programErrors = validateProgramRoot(program)
  if (programErrors.length > 0) {
    console.error(`Blog external-link check failed: ${programErrors.join("; ")}.`)
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
        urls: extractExternalSourceLinks(body),
      })
    } catch (error) {
      errors.push(`${entry.slug}: ${error.message}`)
    }
  }

  for (const page of pageCitations) {
    const path = join(marketingRoot, page)
    if (!existsSync(path)) {
      errors.push(`${page}: page is missing`)
      continue
    }
    articles.push({
      slug: page,
      urls: extractPageExternalLinks(readFileSync(path, "utf8")),
    })
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
