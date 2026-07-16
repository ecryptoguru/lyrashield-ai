#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { validateImageLibrary } from "./blog-validation-lib.mjs"

const marketingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(marketingRoot, "../..")
const manifestRoot = join(repositoryRoot, "docs/editorial/blog-image-manifests")
const releases = ["authority", "batch-1", "batch-2", "batch-3", "batch-4", "batch-5", "batch-6"]

function releaseOption(arguments_) {
  const index = arguments_.indexOf("--release")
  if (index === -1) return {}
  if (!arguments_[index + 1] || arguments_[index + 1].startsWith("--")) {
    return { error: "--release requires a value" }
  }
  return { value: arguments_[index + 1] }
}

function fail(errors) {
  console.error(`Blog image validation failed (${errors.length} violations):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
}

function main() {
  const parsedRelease = releaseOption(process.argv.slice(2))
  if (parsedRelease.error) {
    fail([parsedRelease.error])
    return
  }
  const requested = parsedRelease.value
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
  const knownImageIds = new Set()
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
      else {
        manifests.push({ release, entries })
        for (const entry of entries) if (entry?.imageId) knownImageIds.add(entry.imageId)
      }
    } catch (error) {
      errors.push(`${release} image manifest could not be read: ${error.message}`)
    }
  }

  for (const release of releases.filter((name) => !selected.includes(name))) {
    try {
      const entries = JSON.parse(readFileSync(join(manifestRoot, `${release}.json`), "utf8"))
      if (Array.isArray(entries)) {
        for (const entry of entries) if (entry?.imageId) knownImageIds.add(entry.imageId)
      }
    } catch {
      // Non-selected releases do not block this release, but valid assignments still distinguish
      // future catalog entries from true orphans.
    }
  }

  if (!catalog || Array.isArray(catalog) || typeof catalog !== "object") {
    errors.push("blog image catalog must be a top-level object")
  } else {
    errors.push(
      ...validateImageLibrary(catalog, manifests, marketingRoot, {
        finalDistribution,
        validateDeclaredUsage: finalDistribution || requested === "all" || !requested,
        knownImageIds,
      })
    )
  }

  const uniqueErrors = [...new Set(errors)]
  if (uniqueErrors.length > 0) fail(uniqueErrors)
  else console.log(`Blog image validation passed for ${selected.join(", ")}.`)
}

main()
