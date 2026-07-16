import { readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import sharp from "sharp"
import {
  BLOG_IMAGE_OUTPUTS,
  buildCatalogEntry,
  collectImageDefinitions,
  qualitySequence,
  sha256,
  stableJson,
  validateSourceDimensions,
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
const reportFile = resolve(
  motionRoot,
  "renders/blog-image-previews/byte-budget-report.json"
)

async function loadManifests() {
  const files = (await readdir(manifestDirectory))
    .filter((file) => file.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))

  if (files.length === 0) throw new Error(`No image manifests found in ${manifestDirectory}`)

  return Promise.all(
    files.map(async (file) => ({
      file,
      path: resolve(manifestDirectory, file),
      entries: JSON.parse(await readFile(resolve(manifestDirectory, file), "utf8")),
    }))
  )
}

function validateDeclaredUsage(manifests, definitions) {
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      const expected = definitions.get(entry.imageId)?.usageCount
      if (entry.usageCount !== expected) {
        throw new Error(
          `${manifest.file} declares usageCount ${entry.usageCount} for ${entry.imageId}; expected ${expected}`
        )
      }
    }
  }
}

function imagePipeline(source, output) {
  return sharp(source, { failOn: "error" })
    .rotate()
    .resize(output.width, output.height, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: true,
    })
}

async function encodeAtQuality(source, output, quality) {
  const pipeline = imagePipeline(source, output)

  if (output.format === "avif") {
    return pipeline.avif({ quality, effort: output.effort }).toBuffer()
  }
  if (output.format === "webp") {
    return pipeline.webp({ quality, effort: output.effort }).toBuffer()
  }
  return pipeline
    .jpeg({ quality, progressive: true, chromaSubsampling: "4:2:0" })
    .toBuffer()
}

async function deriveOutput(source, imageId, output) {
  let lastSize = 0

  for (const quality of qualitySequence(output.initialQuality, output.minimumQuality)) {
    const buffer = await encodeAtQuality(source, output, quality)
    lastSize = buffer.byteLength
    if (lastSize <= output.budgetBytes) return { buffer, quality }
  }

  throw new Error(
    `${imageId}/${output.filename} is ${lastSize} bytes at minimum quality ${output.minimumQuality}; budget is ${output.budgetBytes} bytes`
  )
}

async function prepareImage(definition) {
  const sourceFile = resolve(masterDirectory, definition.imageId, "source.png")
  const source = await readFile(sourceFile)
  const metadata = await sharp(source, { failOn: "error" }).metadata()
  const dimensionErrors = validateSourceDimensions(metadata)
  if (metadata.format !== "png") {
    dimensionErrors.push(`Source must be PNG; received ${metadata.format ?? "unknown"}`)
  }
  if (dimensionErrors.length > 0) {
    throw new Error(`${definition.imageId}: ${dimensionErrors.join("; ")}`)
  }

  const derivatives = []
  for (const output of BLOG_IMAGE_OUTPUTS) {
    const derived = await deriveOutput(source, definition.imageId, output)
    derivatives.push({ output, ...derived })
  }

  return {
    definition,
    sourceHash: sha256(source),
    derivatives,
  }
}

async function persist(preparedImages, manifests) {
  const catalog = {}
  const report = {
    version: 1,
    imageCount: preparedImages.length,
    outputCount: preparedImages.length * BLOG_IMAGE_OUTPUTS.length,
    images: {},
  }
  const sourceHashes = new Map()

  for (const image of preparedImages) {
    const { definition } = image
    const outputDirectory = resolve(
      publicDirectory,
      `images/blog/library/${definition.imageId}`
    )
    await mkdir(outputDirectory, { recursive: true })

    const outputReport = {}
    for (const derivative of image.derivatives) {
      const file = resolve(outputDirectory, derivative.output.filename)
      await writeFile(file, derivative.buffer)
      outputReport[derivative.output.key] = {
        path: `/images/blog/library/${definition.imageId}/${derivative.output.filename}`,
        bytes: derivative.buffer.byteLength,
        budgetBytes: derivative.output.budgetBytes,
        quality: derivative.quality,
        sha256: sha256(derivative.buffer),
      }
    }

    catalog[definition.imageId] = buildCatalogEntry(definition)
    report.images[definition.imageId] = {
      sourceHash: image.sourceHash,
      outputs: outputReport,
    }
    sourceHashes.set(definition.imageId, image.sourceHash)
  }

  await mkdir(dirname(catalogFile), { recursive: true })
  await writeFile(catalogFile, stableJson(catalog))

  for (const manifest of manifests) {
    const entries = manifest.entries.map((entry) => ({
      ...entry,
      sourceHash: sourceHashes.get(entry.imageId),
    }))
    await writeFile(manifest.path, stableJson(entries))
  }

  await mkdir(dirname(reportFile), { recursive: true })
  await writeFile(reportFile, stableJson(report))
}

async function main() {
  const manifests = await loadManifests()
  const definitions = collectImageDefinitions(manifests)
  validateDeclaredUsage(manifests, definitions)
  if (definitions.size !== 36) {
    throw new Error(`Expected 36 unique image definitions; received ${definitions.size}`)
  }

  const preparedImages = []
  for (const definition of definitions.values()) {
    process.stdout.write(`Deriving ${definition.imageId}... `)
    preparedImages.push(await prepareImage(definition))
    process.stdout.write("ok\n")
  }

  await persist(preparedImages, manifests)
  console.log(
    `Derived ${preparedImages.length} catalog images and ${preparedImages.length * BLOG_IMAGE_OUTPUTS.length} optimized files.`
  )
  console.log(`Byte-budget report: ${reportFile}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
