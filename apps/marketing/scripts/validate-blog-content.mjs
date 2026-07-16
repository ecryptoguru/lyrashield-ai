#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parseArticle, validateArticle } from "./blog-validation-lib.mjs"

const marketingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(marketingRoot, "../..")
const contentRoot = join(marketingRoot, "src/content")
const manifestRoot = join(repositoryRoot, "docs/editorial/blog-image-manifests")
const releaseOrder = ["authority", "batch-1", "batch-2", "batch-3", "batch-4", "batch-5", "batch-6"]

function releaseArgument(argv) {
  const index = argv.indexOf("--release")
  return index === -1 ? "all" : argv[index + 1]
}

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    errors.push(`${label} could not be read: ${error.message}`)
    return null
  }
}

function articleFiles() {
  const root = join(contentRoot, "blog")
  if (!existsSync(root)) return new Map()
  return new Map(
    readdirSync(root)
      .filter((file) => /\.(?:md|mdx)$/.test(file))
      .map((file) => [file.replace(/\.(?:md|mdx)$/, ""), join(root, file)])
  )
}

function addToIndex(index, key, slug) {
  if (!key) return
  const values = index.get(key) ?? []
  values.push(slug)
  index.set(key, values)
}

function printResult(release, errors) {
  if (errors.length === 0) {
    console.log(`Blog content validation passed for ${release}.`)
    return
  }
  console.error(`Blog content validation failed for ${release} (${errors.length} violations):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
}

function main() {
  const errors = []
  const release = releaseArgument(process.argv.slice(2))
  if (!release || (release !== "all" && !releaseOrder.includes(release))) {
    printResult(release ?? "unknown", [`unknown release: ${release ?? "missing"}`])
    return
  }

  const program = readJson(join(contentRoot, "blog-program.json"), "blog program", errors)
  const catalog = readJson(
    join(contentRoot, "blog-images/images.json"),
    "blog image catalog",
    errors
  )
  if (!Array.isArray(program)) errors.push("blog program must be a top-level array")
  if (!catalog || Array.isArray(catalog) || typeof catalog !== "object") {
    errors.push("blog image catalog must be a top-level object")
  }
  if (!Array.isArray(program) || !catalog || Array.isArray(catalog)) {
    printResult(release, errors)
    return
  }

  const releases = release === "all" ? releaseOrder : [release]
  const selectedEntries = program.filter((entry) => releases.includes(entry.batch))
  const selectedSlugs = new Set(selectedEntries.map((entry) => entry.slug))
  const selectedManifestEntries = new Map()

  for (const name of releases) {
    const path = join(manifestRoot, `${name}.json`)
    if (!existsSync(path)) {
      errors.push(`missing image manifest: ${name}.json`)
      continue
    }
    const manifest = readJson(path, `${name} image manifest`, errors)
    if (!Array.isArray(manifest)) {
      errors.push(`${name} image manifest must be a top-level array`)
      continue
    }
    const expectedManifestSlugs = new Set(
      program.filter((entry) => entry.batch === name).map((entry) => entry.slug)
    )
    const seenManifestSlugs = new Set()
    for (const item of manifest) {
      if (item?.slug) {
        if (seenManifestSlugs.has(item.slug))
          errors.push(`${name}: duplicate image assignment ${item.slug}`)
        seenManifestSlugs.add(item.slug)
        selectedManifestEntries.set(item.slug, item)
        if (!expectedManifestSlugs.has(item.slug)) {
          errors.push(`${name}: unmapped image assignment ${item.slug}`)
        }
      }
      if (item?.imageId && !catalog[item.imageId]) {
        errors.push(`${item.slug ?? name}: missing image catalog entry ${item.imageId}`)
      }
    }
    for (const slug of expectedManifestSlugs) {
      if (!seenManifestSlugs.has(slug)) errors.push(`${name}: missing image assignment ${slug}`)
    }
  }

  const files = articleFiles()
  const articles = new Map()
  const titles = new Map()
  const descriptions = new Map()
  const releaseLimit = release === "all" ? releaseOrder.length - 1 : releaseOrder.indexOf(release)
  const availableEntries = program.filter(
    (entry) => releaseOrder.indexOf(entry.batch) <= releaseLimit
  )
  for (const entry of availableEntries) {
    const path = files.get(entry.slug)
    if (!path) {
      if (selectedSlugs.has(entry.slug)) {
        errors.push(`missing article: ${entry.slug}.md or ${entry.slug}.mdx`)
      } else {
        errors.push(`missing previously released article: ${entry.slug}`)
      }
      continue
    }
    try {
      const article = { slug: entry.slug, ...parseArticle(readFileSync(path, "utf8")) }
      articles.set(entry.slug, article)
      addToIndex(titles, article.data.title, entry.slug)
      addToIndex(descriptions, article.data.description, entry.slug)
    } catch (error) {
      errors.push(`${entry.slug}: ${error.message}`)
    }
  }

  for (const slug of files.keys()) {
    if (!program.some((entry) => entry.slug === slug))
      errors.push(`unmapped article in collection: ${slug}`)
  }
  if (release === "all") {
    if (selectedEntries.length !== 100)
      errors.push(`blog program must contain 100 entries; found ${selectedEntries.length}`)
  }

  const availableSlugs = new Set(
    availableEntries
      .filter((entry) => articles.get(entry.slug)?.data.draft === false)
      .map((entry) => entry.slug)
  )
  for (const entry of selectedEntries) {
    const article = articles.get(entry.slug)
    if (!article) continue
    const manifestEntry = selectedManifestEntries.get(entry.slug)
    if (!manifestEntry) errors.push(`${entry.slug}: missing release image assignment`)
    for (const error of validateArticle(article, entry, {
      availableSlugs,
      catalog,
      manifestEntry,
      titles,
      descriptions,
    })) {
      errors.push(`${entry.slug}: ${error}`)
    }
  }

  printResult(release, [...new Set(errors)])
}

main()
