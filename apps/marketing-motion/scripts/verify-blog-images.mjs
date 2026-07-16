import { isDeepStrictEqual } from "node:util"
import { access, readFile, readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import {
  BLOG_IMAGE_OUTPUTS,
  buildCatalogEntry,
  collectImageDefinitions,
  sha256,
} from "./blog-image-lib.mjs"

const motionRoot = resolve(import.meta.dirname, "..")
const repositoryRoot = resolve(motionRoot, "../..")
const manifestDirectory = resolve(repositoryRoot, "docs/editorial/blog-image-manifests")
const masterDirectory = resolve(motionRoot, "renders/blog-masters")
const publicDirectory = resolve(repositoryRoot, "apps/marketing/public")
const catalogFile = resolve(
  repositoryRoot,
  "apps/marketing/src/content/blog-images/images.json"
)
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

function parseArguments(arguments_) {
  const allowed = new Set(["--", "--allow-empty"])
  const unknown = arguments_.filter((argument) => !allowed.has(argument))
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(", ")}`)
  return { allowEmpty: arguments_.includes("--allow-empty") }
}

async function loadManifests() {
  const files = (await readdir(manifestDirectory))
    .filter((file) => file.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))

  return Promise.all(
    files.map(async (file) => ({
      file,
      entries: JSON.parse(await readFile(resolve(manifestDirectory, file), "utf8")),
    }))
  )
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function verifyManifestHashes(manifests, definitions) {
  const hashes = new Map()
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (!HASH_PATTERN.test(entry.sourceHash)) {
        throw new Error(`${manifest.file} has an invalid sourceHash for ${entry.imageId}`)
      }
      const previous = hashes.get(entry.imageId)
      if (previous && previous !== entry.sourceHash) {
        throw new Error(`${entry.imageId} has conflicting sourceHash values`)
      }
      hashes.set(entry.imageId, entry.sourceHash)
    }
  }

  for (const imageId of definitions.keys()) {
    if (!hashes.has(imageId)) throw new Error(`${imageId} has no sourceHash in the manifests`)
  }
  return hashes
}

async function verifyMasterHash(imageId, expectedHash) {
  const sourceFile = resolve(masterDirectory, imageId, "source.png")
  if (!(await exists(sourceFile))) return

  const actualHash = sha256(await readFile(sourceFile))
  if (actualHash !== expectedHash) {
    throw new Error(`${imageId} source hash does not match its manifest`)
  }
}

async function verifyDerivative(sharp, imageId, catalogEntry, output) {
  const expectedPath = buildCatalogEntry({ imageId, ...catalogEntry })[output.key]
  const publicPath = catalogEntry[output.key]
  if (publicPath !== expectedPath) {
    throw new Error(`${imageId}.${output.key} must be ${expectedPath}`)
  }

  const file = resolve(publicDirectory, publicPath.slice(1))
  const fileStats = await stat(file)
  if (!fileStats.isFile()) throw new Error(`${publicPath} is not a file`)
  if (fileStats.size > output.budgetBytes) {
    throw new Error(
      `${publicPath} is ${fileStats.size} bytes; budget is ${output.budgetBytes} bytes`
    )
  }

  const metadata = await sharp(file, { failOn: "error" }).metadata()
  if (
    metadata.width !== output.width ||
    metadata.height !== output.height ||
    metadata.format !== output.metadataFormat
  ) {
    throw new Error(
      `${publicPath} must be ${output.width}x${output.height} ${output.format}; received ${metadata.width}x${metadata.height} ${metadata.format}`
    )
  }
  if (metadata.exif || metadata.icc || metadata.iptc || metadata.xmp) {
    throw new Error(`${publicPath} contains metadata that should have been stripped`)
  }
}

async function main() {
  const { allowEmpty } = parseArguments(process.argv.slice(2))
  const catalog = JSON.parse(await readFile(catalogFile, "utf8"))
  const catalogIds = Object.keys(catalog).sort((left, right) => left.localeCompare(right))

  if (catalogIds.length === 0) {
    if (!allowEmpty) throw new Error("Blog image catalog is empty; pass --allow-empty before creation")
    console.log("Verified 0 catalog images (allow-empty).")
    return
  }

  const manifests = await loadManifests()
  const definitions = collectImageDefinitions(manifests)
  if (definitions.size !== 36) {
    throw new Error(`Expected 36 unique image definitions; received ${definitions.size}`)
  }
  const definitionIds = [...definitions.keys()]
  if (!isDeepStrictEqual(catalogIds, definitionIds)) {
    throw new Error("Catalog image IDs do not exactly match the manifest image IDs")
  }

  const manifestHashes = verifyManifestHashes(manifests, definitions)
  const { default: sharp } = await import("sharp")

  for (const imageId of catalogIds) {
    const expectedEntry = buildCatalogEntry(definitions.get(imageId))
    if (!isDeepStrictEqual(catalog[imageId], expectedEntry)) {
      throw new Error(`${imageId} catalog entry does not match its manifest definition`)
    }

    await verifyMasterHash(imageId, manifestHashes.get(imageId))
    for (const output of BLOG_IMAGE_OUTPUTS) {
      await verifyDerivative(sharp, imageId, catalog[imageId], output)
    }
  }

  console.log(
    `Verified ${catalogIds.length} catalog images and ${catalogIds.length * BLOG_IMAGE_OUTPUTS.length} optimized files.`
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
