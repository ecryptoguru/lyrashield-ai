import { createHash } from "node:crypto"

const IMAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const BLOG_IMAGE_MANIFEST_CONTRACT = Object.freeze([
  Object.freeze({ file: "authority.json", release: "authority", count: 1 }),
  Object.freeze({ file: "batch-1.json", release: "batch-1", count: 17 }),
  Object.freeze({ file: "batch-2.json", release: "batch-2", count: 17 }),
  Object.freeze({ file: "batch-3.json", release: "batch-3", count: 17 }),
  Object.freeze({ file: "batch-4.json", release: "batch-4", count: 16 }),
  Object.freeze({ file: "batch-5.json", release: "batch-5", count: 16 }),
  Object.freeze({ file: "batch-6.json", release: "batch-6", count: 16 }),
])

export const BLOG_IMAGE_OUTPUTS = Object.freeze([
  Object.freeze({
    key: "avif",
    filename: "hero.avif",
    format: "avif",
    metadataFormat: "heif",
    width: 1600,
    height: 900,
    budgetBytes: 220_000,
    initialQuality: 58,
    minimumQuality: 46,
    effort: 7,
  }),
  Object.freeze({
    key: "webp",
    filename: "hero.webp",
    format: "webp",
    metadataFormat: "webp",
    width: 1600,
    height: 900,
    budgetBytes: 320_000,
    initialQuality: 76,
    minimumQuality: 66,
    effort: 6,
  }),
  Object.freeze({
    key: "jpeg",
    filename: "hero.jpg",
    format: "jpeg",
    metadataFormat: "jpeg",
    width: 1600,
    height: 900,
    budgetBytes: 320_000,
    initialQuality: 80,
    minimumQuality: 70,
  }),
  Object.freeze({
    key: "og",
    filename: "og.jpg",
    format: "jpeg",
    metadataFormat: "jpeg",
    width: 1200,
    height: 630,
    budgetBytes: 350_000,
    initialQuality: 80,
    minimumQuality: 70,
  }),
  Object.freeze({
    key: "socialPortrait",
    filename: "social-portrait.jpg",
    format: "jpeg",
    metadataFormat: "jpeg",
    width: 1080,
    height: 1350,
    budgetBytes: 350_000,
    initialQuality: 80,
    minimumQuality: 70,
  }),
])

function assertImageId(imageId) {
  if (typeof imageId !== "string" || !IMAGE_ID_PATTERN.test(imageId)) {
    throw new Error(`Invalid blog image ID: ${JSON.stringify(imageId)}`)
  }
}

export function outputPaths(imageId) {
  assertImageId(imageId)
  const base = `/images/blog/library/${imageId}`

  return Object.fromEntries(
    BLOG_IMAGE_OUTPUTS.map(({ key, filename }) => [key, `${base}/${filename}`])
  )
}

export function validateSourceDimensions(metadata) {
  const { width, height } = metadata ?? {}
  const errors = []

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return ["Source dimensions must be available as whole pixels"]
  }
  if (width !== height) {
    errors.push(`Source must be square; received ${width}x${height}`)
  }
  if (width < 2048 || height < 2048) {
    errors.push(`Source must be at least 2048x2048; received ${width}x${height}`)
  }

  return errors
}

export function qualitySequence(initialQuality, minimumQuality) {
  if (
    !Number.isInteger(initialQuality) ||
    !Number.isInteger(minimumQuality) ||
    initialQuality < minimumQuality
  ) {
    throw new Error("Initial quality must be an integer greater than or equal to minimum quality")
  }

  const qualities = []
  for (let quality = initialQuality; quality >= minimumQuality; quality -= 2) {
    qualities.push(quality)
  }
  if (qualities.at(-1) !== minimumQuality) qualities.push(minimumQuality)
  return qualities
}

function requireText(entry, field, file) {
  if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
    throw new Error(`${file} contains an entry with an invalid ${field}`)
  }
  return entry[field]
}

export function collectImageDefinitions(manifests) {
  const definitions = new Map()

  for (const manifest of manifests) {
    if (!Array.isArray(manifest.entries)) {
      throw new Error(`${manifest.file} must contain a top-level array`)
    }

    for (const entry of manifest.entries) {
      const imageId = requireText(entry, "imageId", manifest.file)
      const cluster = requireText(entry, "cluster", manifest.file)
      const alt = requireText(entry, "alt", manifest.file)
      assertImageId(imageId)

      const existing = definitions.get(imageId)
      if (!existing) {
        definitions.set(imageId, {
          imageId,
          cluster,
          alt,
          usageCount: 1,
          manifestFiles: [manifest.file],
        })
        continue
      }

      if (existing.cluster !== cluster) {
        throw new Error(
          `${imageId} has conflicting cluster values: ${existing.cluster} and ${cluster}`
        )
      }
      if (existing.alt !== alt) {
        throw new Error(`${imageId} has conflicting alt text across manifests`)
      }
      existing.usageCount += 1
      if (!existing.manifestFiles.includes(manifest.file)) {
        existing.manifestFiles.push(manifest.file)
      }
    }
  }

  return new Map([...definitions].sort(([left], [right]) => left.localeCompare(right)))
}

export function validateManifestSet(manifests, contract = BLOG_IMAGE_MANIFEST_CONTRACT) {
  if (!Array.isArray(manifests)) throw new Error("Blog image manifests must be an array")

  const actualFiles = manifests
    .map(({ file }) => file)
    .sort((left, right) => left.localeCompare(right))
  const expectedFiles = contract
    .map(({ file }) => file)
    .sort((left, right) => left.localeCompare(right))
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Manifest filenames must be exactly: ${expectedFiles.join(", ")}`)
  }

  const byFile = new Map(manifests.map((manifest) => [manifest.file, manifest]))
  for (const expected of contract) {
    const manifest = byFile.get(expected.file)
    if (!Array.isArray(manifest?.entries)) {
      throw new Error(`${expected.file} must contain a top-level array`)
    }
    if (manifest.entries.length !== expected.count) {
      throw new Error(
        `${expected.file} must contain exactly ${expected.count} entries; received ${manifest.entries.length}`
      )
    }
  }

  const definitions = collectImageDefinitions(
    contract.map(({ file }) => ({ file, entries: byFile.get(file).entries }))
  )
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      const actualUsage = definitions.get(entry.imageId)?.usageCount
      if (!Number.isInteger(entry.usageCount) || entry.usageCount !== actualUsage) {
        throw new Error(
          `${manifest.file} declares usageCount ${entry.usageCount} for ${entry.imageId}; expected ${actualUsage}`
        )
      }
    }
  }

  return definitions
}

export function buildCatalogEntry({ imageId, cluster, alt }) {
  return {
    cluster,
    ...outputPaths(imageId),
    alt,
    width: 1600,
    height: 900,
  }
}

export function sha256(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}
