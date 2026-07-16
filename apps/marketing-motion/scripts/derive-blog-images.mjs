import { randomUUID } from "node:crypto"
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import sharp from "sharp"
import {
  BLOG_IMAGE_MANIFEST_CONTRACT,
  BLOG_IMAGE_OUTPUTS,
  buildCatalogEntry,
  qualitySequence,
  sha256,
  stableJson,
  validateManifestSet,
  validateSourceDimensions,
} from "./blog-image-lib.mjs"

const defaultMotionRoot = resolve(import.meta.dirname, "..")
const defaultRepositoryRoot = resolve(defaultMotionRoot, "../..")

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
    reportFile: resolve(motionRoot, "renders/blog-image-previews/byte-budget-report.json"),
  }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function loadManifests(directory, contract) {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
  const manifests = await Promise.all(
    files.map(async (file) => ({
      file,
      path: resolve(directory, file),
      entries: JSON.parse(await readFile(resolve(directory, file), "utf8")),
    }))
  )
  const definitions = validateManifestSet(manifests, contract)
  return { manifests, definitions }
}

export function encoderOptions(output, quality) {
  if (output.format === "avif") return { quality, effort: output.effort }
  if (output.format === "webp") return { quality, effort: output.effort }
  return { quality, progressive: true, chromaSubsampling: "4:2:0" }
}

function imagePipeline(source, output) {
  return sharp(source, { failOn: "error" }).rotate().resize(output.width, output.height, {
    fit: "cover",
    position: "centre",
    withoutEnlargement: true,
  })
}

async function encodeAtQuality(source, output, quality) {
  const pipeline = imagePipeline(source, output)
  const options = encoderOptions(output, quality)
  if (output.format === "avif") return pipeline.avif(options).toBuffer()
  if (output.format === "webp") return pipeline.webp(options).toBuffer()
  return pipeline.jpeg(options).toBuffer()
}

export async function encodeDerivative(source, imageId, output) {
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

async function prepareImage(definition, masterDirectory, outputs) {
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
  for (const output of outputs) {
    derivatives.push({ output, ...(await encodeDerivative(source, definition.imageId, output)) })
  }
  return { definition, sourceHash: sha256(source), derivatives }
}

async function atomicWrite(file, contents) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, contents)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function replaceDirectory(staged, target) {
  await mkdir(dirname(target), { recursive: true })
  const backup = `${target}.backup-${process.pid}-${randomUUID()}`
  const hadTarget = await pathExists(target)
  if (hadTarget) await rename(target, backup)
  try {
    await rename(staged, target)
    if (hadTarget) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (await pathExists(target)) await rm(target, { recursive: true, force: true })
    if (hadTarget && (await pathExists(backup))) await rename(backup, target)
    throw error
  }
}

async function persist(preparedImages, manifests, paths) {
  const catalog = {}
  const verification = {
    version: 1,
    imageCount: preparedImages.length,
    outputCount: preparedImages.length * BLOG_IMAGE_OUTPUTS.length,
    images: {},
  }
  const sourceHashes = new Map()
  const stagedLibrary = join(
    dirname(paths.libraryDirectory),
    `.library-stage-${process.pid}-${randomUUID()}`
  )

  await rm(stagedLibrary, { recursive: true, force: true })
  try {
    for (const image of preparedImages) {
      const { definition } = image
      const outputDirectory = resolve(stagedLibrary, definition.imageId)
      await mkdir(outputDirectory, { recursive: true })
      const outputRecords = {}

      for (const derivative of image.derivatives) {
        const { output, buffer, quality } = derivative
        await writeFile(resolve(outputDirectory, output.filename), buffer)
        outputRecords[output.key] = {
          path: `/images/blog/library/${definition.imageId}/${output.filename}`,
          bytes: buffer.byteLength,
          budgetBytes: output.budgetBytes,
          quality,
          width: output.width,
          height: output.height,
          format: output.format,
          sha256: sha256(buffer),
        }
      }

      catalog[definition.imageId] = buildCatalogEntry(definition)
      verification.images[definition.imageId] = {
        sourceHash: image.sourceHash,
        outputs: outputRecords,
      }
      sourceHashes.set(definition.imageId, image.sourceHash)
    }

    await replaceDirectory(stagedLibrary, paths.libraryDirectory)
  } finally {
    await rm(stagedLibrary, { recursive: true, force: true })
  }

  await atomicWrite(paths.catalogFile, stableJson(catalog))
  await atomicWrite(paths.verificationFile, stableJson(verification))
  for (const manifest of manifests) {
    const entries = manifest.entries.map((entry) => ({
      ...entry,
      sourceHash: sourceHashes.get(entry.imageId),
    }))
    await atomicWrite(manifest.path, stableJson(entries))
  }
  await atomicWrite(paths.reportFile, stableJson(verification))
}

export async function deriveBlogImages(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot
  const motionRoot = options.motionRoot ?? defaultMotionRoot
  const manifestContract = options.manifestContract ?? BLOG_IMAGE_MANIFEST_CONTRACT
  const expectedImageCount = options.expectedImageCount ?? 36
  const outputs = options.outputs ?? BLOG_IMAGE_OUTPUTS
  const paths = pathsFor(repositoryRoot, motionRoot)
  const { manifests, definitions } = await loadManifests(paths.manifestDirectory, manifestContract)

  if (definitions.size !== expectedImageCount) {
    throw new Error(
      `Expected ${expectedImageCount} unique image definitions; received ${definitions.size}`
    )
  }

  const preparedImages = []
  for (const definition of definitions.values()) {
    if (!options.quiet) process.stdout.write(`Deriving ${definition.imageId}... `)
    preparedImages.push(await prepareImage(definition, paths.masterDirectory, outputs))
    if (!options.quiet) process.stdout.write("ok\n")
  }
  await persist(preparedImages, manifests, paths)

  if (!options.quiet) {
    console.log(
      `Derived ${preparedImages.length} catalog images and ${preparedImages.length * outputs.length} optimized files.`
    )
    console.log(`Byte-budget report: ${paths.reportFile}`)
  }
  return { imageCount: preparedImages.length, outputCount: preparedImages.length * outputs.length }
}

async function main() {
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--")
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(", ")}`)
  await deriveBlogImages()
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
