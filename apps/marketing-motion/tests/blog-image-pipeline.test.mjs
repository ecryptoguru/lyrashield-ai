import assert from "node:assert/strict"
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    { version: 1, images: {} }
  )
  return { repositoryRoot, motionRoot, manifestRoot }
}

async function writeSource(motionRoot, imageId) {
  const source = join(motionRoot, "renders/blog-masters", imageId, "source.png")
  mkdirSync(dirname(source), { recursive: true })
  await sharp({
    create: { width: 2048, height: 2048, channels: 3, background: "#07111f" },
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
    images: { stale: { sourceHash: `sha256:${"a".repeat(64)}`, outputs: {} } },
  })
  await assert.rejects(
    () => verifyBlogImages({ ...validWorkspace, allowEmpty: true, quiet: true }),
    /stale image verification records/i
  )

  const invalidWorkspace = makeWorkspace(fullManifestFixture().slice(0, -1))
  await assert.rejects(
    () => verifyBlogImages({ ...invalidWorkspace, allowEmpty: true, quiet: true }),
    /manifest filenames must be exactly/i
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
  await assert.rejects(
    () =>
      deriveBlogImages({
        ...options,
        outputs: [
          {
            ...BLOG_IMAGE_OUTPUTS[2],
            initialQuality: 70,
            minimumQuality: 70,
            budgetBytes: 1,
          },
        ],
      }),
    /minimum quality 70/i
  )
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
