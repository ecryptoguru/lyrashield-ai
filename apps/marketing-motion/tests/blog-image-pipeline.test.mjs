import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import sharp from "sharp"

import {
  BLOG_IMAGE_MANIFEST_CONTRACT,
  BLOG_IMAGE_OUTPUTS,
  stableJson,
  validateManifestSet,
} from "../scripts/blog-image-lib.mjs"
import {
  deriveBlogImages,
  encodeDerivative,
  encoderOptions,
} from "../scripts/derive-blog-images.mjs"
import { verifyBlogImages } from "../scripts/verify-blog-images.mjs"

const MINI_CONTRACT = Object.freeze([{ file: "authority.json", release: "authority", count: 1 }])

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, stableJson(value))
}

function fullManifestFixture() {
  const sharedIds = Array.from({ length: 35 }, (_, index) => `shared-${index + 1}`)
  const assignments = [
    { slug: "authority", imageId: "authority-guide-01", cluster: "authority" },
    ...sharedIds.map((imageId, index) => ({
      slug: `first-${index + 1}`,
      imageId,
      cluster: "verification",
    })),
    ...[...sharedIds.slice(17), ...sharedIds.slice(0, 17)].map((imageId, index) => ({
      slug: `second-${index + 1}`,
      imageId,
      cluster: "verification",
    })),
    ...sharedIds.slice(0, 29).map((imageId, index) => ({
      slug: `third-${index + 1}`,
      imageId,
      cluster: "verification",
    })),
  ]
  const counts = new Map()
  for (const entry of assignments) counts.set(entry.imageId, (counts.get(entry.imageId) ?? 0) + 1)
  for (const entry of assignments) {
    entry.alt = `A deterministic test concept for ${entry.imageId}`
    entry.sourceHash = null
    entry.usageCount = counts.get(entry.imageId)
    entry.approved = false
  }

  let offset = 0
  return BLOG_IMAGE_MANIFEST_CONTRACT.map((contract) => {
    const entries = assignments.slice(offset, offset + contract.count)
    offset += contract.count
    return { file: contract.file, entries }
  })
}

function makeWorkspace(manifests) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "blog-image-pipeline-"))
  const motionRoot = join(repositoryRoot, "apps/marketing-motion")
  const manifestRoot = join(repositoryRoot, "docs/editorial/blog-image-manifests")
  for (const manifest of manifests) writeJson(join(manifestRoot, manifest.file), manifest.entries)
  writeJson(join(repositoryRoot, "apps/marketing/src/content/blog-images/images.json"), {})
  writeJson(
    join(repositoryRoot, "apps/marketing/src/content/blog-images/image-verification.json"),
    { version: 1, imageCount: 0, outputCount: 0, images: {} }
  )
  return { repositoryRoot, motionRoot, manifestRoot }
}

async function writeSource(motionRoot, imageId, background = "#07111f") {
  const source = join(motionRoot, "renders/blog-masters", imageId, "source.png")
  mkdirSync(dirname(source), { recursive: true })
  await sharp({
    create: { width: 2048, height: 2048, channels: 3, background },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="512" height="512"><rect width="512" height="512" fill="white"/></svg>'
        ),
        left: 768,
        top: 768,
      },
    ])
    .withMetadata({ orientation: 1 })
    .png()
    .toFile(source)
  return source
}

function singleImageFixture(imageId = "verification-contract") {
  return {
    slug: "fixture-article",
    imageId,
    cluster: "verification",
    alt: `A deterministic fixture enforcing the image contract for ${imageId}`,
    sourceHash: null,
    usageCount: 1,
    approved: true,
  }
}

function singleImageOptions(workspace) {
  return {
    ...workspace,
    manifestContract: MINI_CONTRACT,
    expectedImageCount: 1,
    quiet: true,
  }
}

function updateRecordedSourceHash(workspace, imageId, source) {
  const sourceHash = `sha256:${createHash("sha256").update(source).digest("hex")}`
  const manifestFile = join(workspace.manifestRoot, "authority.json")
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
  manifest[0].sourceHash = sourceHash
  writeJson(manifestFile, manifest)

  const verificationFile = join(
    workspace.repositoryRoot,
    "apps/marketing/src/content/blog-images/image-verification.json"
  )
  const verification = JSON.parse(readFileSync(verificationFile, "utf8"))
  verification.images[imageId].sourceHash = sourceHash
  writeJson(verificationFile, verification)
}

function snapshotPath(path, relative = ".") {
  const snapshot = new Map()
  if (!statSync(path).isDirectory()) {
    snapshot.set(relative, readFileSync(path))
    return snapshot
  }
  for (const entry of readdirSync(path).sort()) {
    const child = join(path, entry)
    const childRelative = join(relative, entry)
    if (statSync(child).isDirectory()) {
      for (const [name, contents] of snapshotPath(child, childRelative)) {
        snapshot.set(name, contents)
      }
    } else {
      snapshot.set(childRelative, readFileSync(child))
    }
  }
  return snapshot
}

function assertSnapshotEqual(actual, expected) {
  assert.deepEqual([...actual.keys()], [...expected.keys()])
  for (const [path, contents] of expected) {
    assert.deepEqual(actual.get(path), contents, `${path} changed across rollback`)
  }
}

test("requires the exact seven top-level-array manifests and declared aggregate usage", () => {
  const valid = fullManifestFixture()
  assert.equal(validateManifestSet(valid).size, 36)

  assert.throws(
    () => validateManifestSet(valid.slice(0, -1)),
    /manifest filenames must be exactly/i
  )
  assert.throws(
    () => validateManifestSet([...valid, { file: "extra.json", entries: [] }]),
    /manifest filenames must be exactly/i
  )
  assert.throws(
    () =>
      validateManifestSet(valid.map((item, index) => (index ? item : { ...item, entries: {} }))),
    /top-level array/i
  )
  assert.throws(
    () =>
      validateManifestSet(
        valid.map((item, index) =>
          index ? item : { ...item, entries: item.entries.slice(0, item.entries.length - 1) }
        )
      ),
    /must contain exactly 1 entries/i
  )

  const badUsage = structuredClone(valid)
  badUsage[1].entries[0].usageCount += 1
  assert.throws(() => validateManifestSet(badUsage), /usageCount/i)
})

test("pins each encoder's deterministic options", () => {
  assert.deepEqual(encoderOptions(BLOG_IMAGE_OUTPUTS[0], 58), { quality: 58, effort: 7 })
  assert.deepEqual(encoderOptions(BLOG_IMAGE_OUTPUTS[1], 76), { quality: 76, effort: 6 })
  assert.deepEqual(encoderOptions(BLOG_IMAGE_OUTPUTS[2], 80), {
    quality: 80,
    progressive: true,
    chromaSubsampling: "4:2:0",
  })
})

test("allow-empty still validates the canonical manifest set", async () => {
  const validWorkspace = makeWorkspace(fullManifestFixture())
  await assert.rejects(
    () => verifyBlogImages({ ...validWorkspace, quiet: true }),
    /catalog is empty/i
  )
  await assert.doesNotReject(() =>
    verifyBlogImages({ ...validWorkspace, allowEmpty: true, quiet: true })
  )

  const verificationFile = join(
    validWorkspace.repositoryRoot,
    "apps/marketing/src/content/blog-images/image-verification.json"
  )
  writeJson(verificationFile, { version: 2, images: {} })
  await assert.rejects(
    () => verifyBlogImages({ ...validWorkspace, allowEmpty: true, quiet: true }),
    /version 1 object/i
  )
  writeJson(verificationFile, {
    version: 1,
    imageCount: 0,
    outputCount: 0,
    images: { stale: { sourceHash: `sha256:${"a".repeat(64)}`, outputs: {} } },
  })
  await assert.rejects(
    () => verifyBlogImages({ ...validWorkspace, allowEmpty: true, quiet: true }),
    /stale image verification records/i
  )
  writeJson(verificationFile, { version: 1, imageCount: 1, outputCount: 0, images: {} })
  await assert.rejects(
    () => verifyBlogImages({ ...validWorkspace, allowEmpty: true, quiet: true }),
    /imageCount/i
  )
  writeJson(verificationFile, { version: 1, imageCount: 0, outputCount: 5, images: {} })
  await assert.rejects(
    () => verifyBlogImages({ ...validWorkspace, allowEmpty: true, quiet: true }),
    /outputCount/i
  )

  const invalidWorkspace = makeWorkspace(fullManifestFixture().slice(0, -1))
  await assert.rejects(
    () => verifyBlogImages({ ...invalidWorkspace, allowEmpty: true, quiet: true }),
    /manifest filenames must be exactly/i
  )
})

test("verifier rejects present masters outside the square PNG source contract", async () => {
  const manifestEntry = singleImageFixture("verification-source-contract")
  const workspace = makeWorkspace([{ file: "authority.json", entries: [manifestEntry] }])
  const sourceFile = await writeSource(workspace.motionRoot, manifestEntry.imageId)
  const options = singleImageOptions(workspace)
  await deriveBlogImages(options)

  const invalidSources = [
    {
      label: "non-square",
      buffer: await sharp({
        create: { width: 4096, height: 2048, channels: 3, background: "#07111f" },
      })
        .png()
        .toBuffer(),
      message: /square/i,
    },
    {
      label: "undersized",
      buffer: await sharp({
        create: { width: 1024, height: 1024, channels: 3, background: "#07111f" },
      })
        .png()
        .toBuffer(),
      message: /2048/i,
    },
    {
      label: "non-PNG",
      buffer: await sharp({
        create: { width: 2048, height: 2048, channels: 3, background: "#07111f" },
      })
        .jpeg()
        .toBuffer(),
      message: /must be PNG/i,
    },
  ]

  for (const invalid of invalidSources) {
    writeFileSync(sourceFile, invalid.buffer)
    updateRecordedSourceHash(workspace, manifestEntry.imageId, invalid.buffer)
    await assert.rejects(
      () => verifyBlogImages(options),
      invalid.message,
      `${invalid.label} source should fail verification`
    )
  }
})

test("masterless verification rejects JPEGs outside the pinned encoder contract", async () => {
  const manifestEntry = singleImageFixture("verification-masterless-jpeg")
  const workspace = makeWorkspace([{ file: "authority.json", entries: [manifestEntry] }])
  const sourceFile = await writeSource(workspace.motionRoot, manifestEntry.imageId)
  const options = singleImageOptions(workspace)
  await deriveBlogImages(options)

  const verificationFile = join(
    workspace.repositoryRoot,
    "apps/marketing/src/content/blog-images/image-verification.json"
  )
  const verification = JSON.parse(readFileSync(verificationFile, "utf8"))
  const record = verification.images[manifestEntry.imageId].outputs.jpeg
  const output = BLOG_IMAGE_OUTPUTS.find(({ key }) => key === "jpeg")
  const noncanonical = await sharp(readFileSync(sourceFile), { failOn: "error" })
    .rotate()
    .resize(output.width, output.height, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: true,
    })
    .jpeg({ quality: record.quality, progressive: false, chromaSubsampling: "4:4:4" })
    .toBuffer()
  const outputFile = join(
    workspace.repositoryRoot,
    "apps/marketing/public/images/blog/library",
    manifestEntry.imageId,
    output.filename
  )
  writeFileSync(outputFile, noncanonical)
  record.bytes = noncanonical.byteLength
  record.sha256 = `sha256:${createHash("sha256").update(noncanonical).digest("hex")}`
  writeJson(verificationFile, verification)
  rmSync(join(workspace.motionRoot, "renders/blog-masters"), { recursive: true })

  const metadata = await sharp(noncanonical).metadata()
  assert.equal(metadata.isProgressive, false)
  assert.equal(metadata.chromaSubsampling, "4:4:4")
  await assert.rejects(() => verifyBlogImages(options), /encoder contract/i)
})

test("verification and derivation require exactly the five canonical outputs", async () => {
  const manifestEntry = singleImageFixture("verification-output-contract")
  const workspace = makeWorkspace([{ file: "authority.json", entries: [manifestEntry] }])
  await writeSource(workspace.motionRoot, manifestEntry.imageId)
  const options = singleImageOptions(workspace)
  await deriveBlogImages(options)

  const verificationFile = join(
    workspace.repositoryRoot,
    "apps/marketing/src/content/blog-images/image-verification.json"
  )
  const verification = JSON.parse(readFileSync(verificationFile, "utf8"))
  verification.images[manifestEntry.imageId].outputs.legacy = {
    ...verification.images[manifestEntry.imageId].outputs.jpeg,
  }
  writeJson(verificationFile, verification)
  await assert.rejects(() => verifyBlogImages(options), /output keys/i)

  await assert.rejects(
    () => deriveBlogImages({ ...options, outputs: [BLOG_IMAGE_OUTPUTS[2]] }),
    /exactly the five canonical outputs/i
  )
})

test("derives deterministically and detects mutations without source masters", async () => {
  const manifestEntry = {
    slug: "fixture-article",
    imageId: "verification-01",
    cluster: "verification",
    alt: "A centered deterministic fixture crossing a verification boundary",
    sourceHash: null,
    usageCount: 1,
    approved: true,
  }
  const workspace = makeWorkspace([{ file: "authority.json", entries: [manifestEntry] }])
  const source = await writeSource(workspace.motionRoot, manifestEntry.imageId)
  const options = {
    ...workspace,
    manifestContract: MINI_CONTRACT,
    expectedImageCount: 1,
    quiet: true,
  }

  await deriveBlogImages(options)
  await verifyBlogImages(options)

  const verificationFile = join(
    workspace.repositoryRoot,
    "apps/marketing/src/content/blog-images/image-verification.json"
  )
  const firstVerification = readFileSync(verificationFile, "utf8")
  const firstRecord = JSON.parse(firstVerification).images[manifestEntry.imageId]
  assert.match(firstRecord.sourceHash, /^sha256:[a-f0-9]{64}$/)

  const publicImageRoot = join(
    workspace.repositoryRoot,
    "apps/marketing/public/images/blog/library",
    manifestEntry.imageId
  )
  for (const output of BLOG_IMAGE_OUTPUTS) {
    const metadata = await sharp(join(publicImageRoot, output.filename)).metadata()
    assert.equal(metadata.width, output.width)
    assert.equal(metadata.height, output.height)
    assert.equal(metadata.exif, undefined)
    assert.equal(metadata.icc, undefined)
    assert.equal(metadata.xmp, undefined)
    assert.equal(metadata.iptc, undefined)
    assert.ok(firstRecord.outputs[output.key].bytes <= output.budgetBytes)
  }
  const jpegMetadata = await sharp(join(publicImageRoot, "hero.jpg")).metadata()
  assert.equal(jpegMetadata.isProgressive, true)
  assert.equal(jpegMetadata.chromaSubsampling, "4:2:0")

  const center = await sharp(join(publicImageRoot, "hero.jpg"))
    .extract({ left: 800, top: 450, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer()
  assert.ok(center[0] > 240 && center[1] > 240 && center[2] > 240)

  await assert.rejects(
    () =>
      encodeDerivative(readFileSync(source), manifestEntry.imageId, {
        ...BLOG_IMAGE_OUTPUTS[0],
        budgetBytes: 1,
      }),
    /minimum quality 46/i
  )

  const catalogBeforeFailedDerive = readFileSync(
    join(workspace.repositoryRoot, "apps/marketing/src/content/blog-images/images.json"),
    "utf8"
  )
  const heroBeforeFailedDerive = readFileSync(join(publicImageRoot, "hero.jpg"))
  const validSource = readFileSync(source)
  const invalidSource = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#07111f" },
  })
    .png()
    .toBuffer()
  writeFileSync(source, invalidSource)
  await assert.rejects(() => deriveBlogImages(options), /2048/i)
  writeFileSync(source, validSource)
  assert.equal(
    readFileSync(
      join(workspace.repositoryRoot, "apps/marketing/src/content/blog-images/images.json"),
      "utf8"
    ),
    catalogBeforeFailedDerive
  )
  assert.deepEqual(readFileSync(join(publicImageRoot, "hero.jpg")), heroBeforeFailedDerive)

  await deriveBlogImages(options)
  assert.equal(readFileSync(verificationFile, "utf8"), firstVerification)

  const catalogFile = join(
    workspace.repositoryRoot,
    "apps/marketing/src/content/blog-images/images.json"
  )
  const catalogText = readFileSync(catalogFile, "utf8")
  const catalog = JSON.parse(catalogText)
  catalog[manifestEntry.imageId].webp = "/images/blog/library/wrong/hero.webp"
  writeJson(catalogFile, catalog)
  await assert.rejects(() => verifyBlogImages(options), /catalog entry/i)
  writeFileSync(catalogFile, catalogText)

  const changedVerification = JSON.parse(firstVerification)
  changedVerification.images[manifestEntry.imageId].outputs.webp.quality = 1
  writeJson(verificationFile, changedVerification)
  await assert.rejects(() => verifyBlogImages(options), /encoder contract/i)
  writeFileSync(verificationFile, firstVerification)

  const wrongCounts = JSON.parse(firstVerification)
  wrongCounts.imageCount = 2
  writeJson(verificationFile, wrongCounts)
  await assert.rejects(() => verifyBlogImages(options), /imageCount/i)
  wrongCounts.imageCount = 1
  wrongCounts.outputCount = 4
  writeJson(verificationFile, wrongCounts)
  await assert.rejects(() => verifyBlogImages(options), /outputCount/i)
  writeFileSync(verificationFile, firstVerification)

  const qualityTamper = JSON.parse(firstVerification)
  const canonicalQuality = qualityTamper.images[manifestEntry.imageId].outputs.jpeg.quality
  assert.ok(canonicalQuality > BLOG_IMAGE_OUTPUTS[2].minimumQuality)
  const alteredQuality = canonicalQuality - 2
  const alteredDerivative = await encodeDerivative(readFileSync(source), manifestEntry.imageId, {
    ...BLOG_IMAGE_OUTPUTS[2],
    initialQuality: alteredQuality,
    minimumQuality: alteredQuality,
  })
  const alteredHero = join(publicImageRoot, BLOG_IMAGE_OUTPUTS[2].filename)
  writeFileSync(alteredHero, alteredDerivative.buffer)
  qualityTamper.images[manifestEntry.imageId].outputs.jpeg = {
    ...qualityTamper.images[manifestEntry.imageId].outputs.jpeg,
    quality: alteredQuality,
    bytes: alteredDerivative.buffer.byteLength,
    sha256: `sha256:${createHash("sha256").update(alteredDerivative.buffer).digest("hex")}`,
  }
  writeJson(verificationFile, qualityTamper)
  await assert.rejects(() => verifyBlogImages(options), /canonical quality selection/i)

  await deriveBlogImages(options)
  assert.equal(readFileSync(verificationFile, "utf8"), firstVerification)

  const manifestFile = join(workspace.manifestRoot, "authority.json")
  const manifestText = readFileSync(manifestFile, "utf8")
  const manifest = JSON.parse(manifestText)
  manifest[0].sourceHash = `sha256:${"b".repeat(64)}`
  writeJson(manifestFile, manifest)
  await assert.rejects(() => verifyBlogImages(options), /source hash/i)
  writeFileSync(manifestFile, manifestText)

  rmSync(join(workspace.motionRoot, "renders/blog-masters"), { recursive: true })
  await verifyBlogImages(options)

  const hero = join(publicImageRoot, "hero.jpg")
  const heroBytes = readFileSync(hero)
  appendFileSync(hero, Buffer.from([0]))
  await assert.rejects(() => verifyBlogImages(options), /bytes|hash/i)
  writeFileSync(hero, heroBytes)

  writeFileSync(join(publicImageRoot, "unexpected.txt"), "stale")
  await assert.rejects(() => verifyBlogImages(options), /unexpected verification-01 output/i)
  rmSync(join(publicImageRoot, "unexpected.txt"))

  mkdirSync(
    join(workspace.repositoryRoot, "apps/marketing/public/images/blog/library/stale-image"),
    { recursive: true }
  )
  await assert.rejects(() => verifyBlogImages(options), /unexpected public image entry/i)
})

test("restores every persisted artifact after a metadata commit failure", async () => {
  const manifestEntry = {
    slug: "fixture-article",
    imageId: "verification-rollback",
    cluster: "verification",
    alt: "A deterministic fixture protecting a transactional metadata boundary",
    sourceHash: null,
    usageCount: 1,
    approved: true,
  }
  const workspace = makeWorkspace([{ file: "authority.json", entries: [manifestEntry] }])
  await writeSource(workspace.motionRoot, manifestEntry.imageId)
  const options = {
    ...workspace,
    manifestContract: MINI_CONTRACT,
    expectedImageCount: 1,
    quiet: true,
  }
  await deriveBlogImages(options)

  const persistedPaths = [
    join(workspace.repositoryRoot, "apps/marketing/public/images/blog/library"),
    join(workspace.repositoryRoot, "apps/marketing/src/content/blog-images/images.json"),
    join(
      workspace.repositoryRoot,
      "apps/marketing/src/content/blog-images/image-verification.json"
    ),
    join(workspace.manifestRoot, "authority.json"),
    join(workspace.motionRoot, "renders/blog-image-previews/byte-budget-report.json"),
  ]
  const before = persistedPaths.map((path) => snapshotPath(path))
  await writeSource(workspace.motionRoot, manifestEntry.imageId, "#421811")

  await assert.rejects(
    () =>
      deriveBlogImages({
        ...options,
        persistenceFault(label) {
          if (label === "verification") throw new Error("induced metadata write failure")
        },
      }),
    /induced metadata write failure/i
  )

  persistedPaths.forEach((path, index) => {
    assertSnapshotEqual(snapshotPath(path), before[index])
  })
})
