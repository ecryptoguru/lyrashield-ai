#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { validateImageLibrary } from "./blog-validation-lib.mjs"

const marketingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(marketingRoot, "../..")
const manifestRoot = join(repositoryRoot, "docs/editorial/blog-image-manifests")
const releases = ["authority", "batch-1", "batch-2", "batch-3", "batch-4", "batch-5", "batch-6"]

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(errors) {
  console.error(`Blog image validation failed (${errors.length} violations):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
}

function main() {
  const requested = option("--release")
  const finalDistribution = process.argv.includes("--final-distribution")
  if (requested && requested !== "all" && !releases.includes(requested)) {
    fail([`unknown release: ${requested}`])
    return
  }

  const selected = finalDistribution || !requested || requested === "all" ? releases : [requested]
  const errors = []
  let catalog
  try {
    catalog = JSON.parse(
      readFileSync(join(marketingRoot, "src/content/blog-images/images.json"), "utf8")
    )
  } catch (error) {
    fail([`blog image catalog could not be read: ${error.message}`])
    return
  }

  const manifests = []
  for (const release of selected) {
    const path = join(manifestRoot, `${release}.json`)
    if (!existsSync(path)) {
      errors.push(`missing image manifest: ${release}.json`)
      continue
    }
    try {
      const entries = JSON.parse(readFileSync(path, "utf8"))
      if (!Array.isArray(entries))
        errors.push(`${release} image manifest must be a top-level array`)
      else manifests.push({ release, entries })
    } catch (error) {
      errors.push(`${release} image manifest could not be read: ${error.message}`)
    }
  }

  if (!catalog || Array.isArray(catalog) || typeof catalog !== "object") {
    errors.push("blog image catalog must be a top-level object")
  } else {
    errors.push(
      ...validateImageLibrary(catalog, manifests, marketingRoot, {
        finalDistribution,
        validateDeclaredUsage: finalDistribution || requested === "all" || !requested,
      })
    )
  }

  const uniqueErrors = [...new Set(errors)]
  if (uniqueErrors.length > 0) fail(uniqueErrors)
  else console.log(`Blog image validation passed for ${selected.join(", ")}.`)
}

main()
