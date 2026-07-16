import { isDeepStrictEqual } from "node:util"
import { access, readFile, readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  BLOG_IMAGE_MANIFEST_CONTRACT,
  BLOG_IMAGE_OUTPUTS,
  buildCatalogEntry,
  qualitySequence,
  sha256,
  validateManifestSet,
} from "./blog-image-lib.mjs"
import { encodeDerivative } from "./derive-blog-images.mjs"

const defaultMotionRoot = resolve(import.meta.dirname, "..")
const defaultRepositoryRoot = resolve(defaultMotionRoot, "../..")
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

function pathsFor(repositoryRoot, motionRoot) {
  return {
    manifestDirectory: resolve(repositoryRoot, "docs/editorial/blog-image-manifests"),
    masterDirectory: resolve(motionRoot, "renders/blog-masters"),
    libraryDirectory: resolve(repositoryRoot, "apps/marketing/public/images/blog/library"),
    catalogFile: resolve(repositoryRoot, "apps/marketing/src/content/blog-images/images.json"),
    verificationFile: resolve(
      repositoryRoot,
      "apps/marketing/src/content/blog-images/image-verification.json"
    ),
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`)
  }
}

async function loadManifests(directory, contract) {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
  const manifests = await Promise.all(
    files.map(async (file) => ({
      file,
      entries: await readJson(resolve(directory, file), `${file} manifest`),
    }))
  )
  return { manifests, definitions: validateManifestSet(manifests, contract) }
}

function verifyManifestHashes(manifests, definitions) {
  const hashes = new Map()
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (!HASH_PATTERN.test(entry.sourceHash)) {
        throw new Error(`${manifest.file} has an invalid source hash for ${entry.imageId}`)
      }
      const previous = hashes.get(entry.imageId)
      if (previous && previous !== entry.sourceHash) {
        throw new Error(`${entry.imageId} has conflicting source hash values`)
      }
      hashes.set(entry.imageId, entry.sourceHash)
    }
  }
  for (const imageId of definitions.keys()) {
    if (!hashes.has(imageId)) throw new Error(`${imageId} has no source hash in the manifests`)
  }
  return hashes
}

async function verifyManagedEntries(directory, expectedEntries, label) {
  const actual = (await exists(directory))
    ? (await readdir(directory)).sort((left, right) => left.localeCompare(right))
    : []
  const expected = [...expectedEntries].sort((left, right) => left.localeCompare(right))
  if (!isDeepStrictEqual(actual, expected)) {
    const unexpected = actual.filter((entry) => !expected.includes(entry))
    const missing = expected.filter((entry) => !actual.includes(entry))
    if (unexpected.length > 0) {
      throw new Error(`Unexpected ${label} entry: ${unexpected.join(", ")}`)
    }
    throw new Error(`Missing ${label} entry: ${missing.join(", ")}`)
  }
}

function validateVerificationManifest(verification) {
  if (
    verification?.version !== 1 ||
    !verification.images ||
    Array.isArray(verification.images) ||
    typeof verification.images !== "object"
  ) {
    throw new Error("Blog image verification manifest must be a version 1 object")
  }
}

async function verifyDerivative({
  sharp,
  imageId,
  output,
  catalogEntry,
  verificationRecord,
  libraryDirectory,
  source,
}) {
  const expectedPath = buildCatalogEntry({ imageId, ...catalogEntry })[output.key]
  if (catalogEntry[output.key] !== expectedPath) {
    throw new Error(`${imageId} catalog entry ${output.key} must be ${expectedPath}`)
  }

  const record = verificationRecord?.outputs?.[output.key]
  if (!record || record.path !== expectedPath) {
    throw new Error(`${imageId}.${output.key} verification record is missing or has the wrong path`)
  }
  if (
    record.width !== output.width ||
    record.height !== output.height ||
    record.format !== output.format ||
    record.budgetBytes !== output.budgetBytes ||
    !qualitySequence(output.initialQuality, output.minimumQuality).includes(record.quality) ||
    !HASH_PATTERN.test(record.sha256)
  ) {
    throw new Error(
      `${imageId}.${output.key} verification record does not match the encoder contract`
    )
  }

  const file = resolve(libraryDirectory, imageId, output.filename)
  const fileStats = await stat(file)
  if (!fileStats.isFile()) throw new Error(`${expectedPath} is not a file`)
  if (fileStats.size !== record.bytes) {
    throw new Error(`${expectedPath} bytes do not match the verification manifest`)
  }
  if (fileStats.size > output.budgetBytes) {
    throw new Error(`${expectedPath} exceeds its ${output.budgetBytes}-byte budget`)
  }

  const buffer = await readFile(file)
  if (sha256(buffer) !== record.sha256) {
    throw new Error(`${expectedPath} hash does not match the verification manifest`)
  }
  const metadata = await sharp(buffer, { failOn: "error" }).metadata()
  if (
    metadata.width !== output.width ||
    metadata.height !== output.height ||
    metadata.format !== output.metadataFormat
  ) {
    throw new Error(`${expectedPath} dimensions or format do not match the output contract`)
  }
  if (metadata.exif || metadata.icc || metadata.iptc || metadata.xmp) {
    throw new Error(`${expectedPath} contains metadata that should have been stripped`)
  }

  if (source) {
    const regenerated = await encodeDerivative(source, imageId, output)
    if (regenerated.quality !== record.quality) {
      throw new Error(
        `${expectedPath} does not match the canonical quality selection for its source`
      )
    }
    if (sha256(regenerated.buffer) !== record.sha256) {
      throw new Error(`${expectedPath} is not deterministic for its source and encoder settings`)
    }
  }
}

export async function verifyBlogImages(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot
  const motionRoot = options.motionRoot ?? defaultMotionRoot
  const manifestContract = options.manifestContract ?? BLOG_IMAGE_MANIFEST_CONTRACT
  const expectedImageCount = options.expectedImageCount ?? 36
  const paths = pathsFor(repositoryRoot, motionRoot)
  const { manifests, definitions } = await loadManifests(paths.manifestDirectory, manifestContract)
  if (definitions.size !== expectedImageCount) {
    throw new Error(
      `Expected ${expectedImageCount} unique image definitions; received ${definitions.size}`
    )
  }

  const catalog = await readJson(paths.catalogFile, "Blog image catalog")
  if (!catalog || Array.isArray(catalog) || typeof catalog !== "object") {
    throw new Error("Blog image catalog must be a top-level object")
  }
  const verification = await readJson(paths.verificationFile, "Blog image verification manifest")
  validateVerificationManifest(verification)
  const catalogIds = Object.keys(catalog).sort((left, right) => left.localeCompare(right))
  if (verification.imageCount !== catalogIds.length) {
    throw new Error(
      `Verification imageCount must be ${catalogIds.length}; received ${verification.imageCount}`
    )
  }
  const expectedOutputCount = catalogIds.length * BLOG_IMAGE_OUTPUTS.length
  if (verification.outputCount !== expectedOutputCount) {
    throw new Error(
      `Verification outputCount must be ${expectedOutputCount}; received ${verification.outputCount}`
    )
  }

  if (catalogIds.length === 0) {
    if (!options.allowEmpty) {
      throw new Error("Blog image catalog is empty; pass --allow-empty before creation")
    }
    if (Object.keys(verification.images).length !== 0) {
      throw new Error("Empty catalog has stale image verification records")
    }
    await verifyManagedEntries(paths.libraryDirectory, [], "public image")
    if (!options.quiet) console.log("Verified 0 catalog images (allow-empty).")
    return { imageCount: 0, outputCount: 0 }
  }

  const definitionIds = [...definitions.keys()]
  if (!isDeepStrictEqual(catalogIds, definitionIds)) {
    throw new Error("Catalog image IDs do not exactly match the manifest image IDs")
  }
  const verificationIds = Object.keys(verification.images).sort((left, right) =>
    left.localeCompare(right)
  )
  if (!isDeepStrictEqual(verificationIds, catalogIds)) {
    throw new Error("Verification image IDs do not exactly match the catalog image IDs")
  }
  await verifyManagedEntries(paths.libraryDirectory, catalogIds, "public image")

  const manifestHashes = verifyManifestHashes(manifests, definitions)
  const { default: sharp } = await import("sharp")
  for (const imageId of catalogIds) {
    const expectedEntry = buildCatalogEntry(definitions.get(imageId))
    if (!isDeepStrictEqual(catalog[imageId], expectedEntry)) {
      throw new Error(`${imageId} catalog entry does not match its manifest definition`)
    }
    const verificationRecord = verification.images[imageId]
    if (verificationRecord.sourceHash !== manifestHashes.get(imageId)) {
      throw new Error(`${imageId} source hash does not match its verification record`)
    }
    await verifyManagedEntries(
      resolve(paths.libraryDirectory, imageId),
      BLOG_IMAGE_OUTPUTS.map(({ filename }) => filename),
      `${imageId} output`
    )

    const sourceFile = resolve(paths.masterDirectory, imageId, "source.png")
    const source = (await exists(sourceFile)) ? await readFile(sourceFile) : null
    if (source && sha256(source) !== manifestHashes.get(imageId)) {
      throw new Error(`${imageId} source hash does not match its manifest`)
    }
    for (const output of BLOG_IMAGE_OUTPUTS) {
      await verifyDerivative({
        sharp,
        imageId,
        output,
        catalogEntry: catalog[imageId],
        verificationRecord,
        libraryDirectory: paths.libraryDirectory,
        source,
      })
    }
  }

  const result = {
    imageCount: catalogIds.length,
    outputCount: catalogIds.length * BLOG_IMAGE_OUTPUTS.length,
  }
  if (!options.quiet) {
    console.log(
      `Verified ${result.imageCount} catalog images and ${result.outputCount} optimized files.`
    )
  }
  return result
}

function parseArguments(arguments_) {
  const allowed = new Set(["--", "--allow-empty"])
  const unknown = arguments_.filter((argument) => !allowed.has(argument))
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(", ")}`)
  return { allowEmpty: arguments_.includes("--allow-empty") }
}

async function main() {
  await verifyBlogImages(parseArguments(process.argv.slice(2)))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
