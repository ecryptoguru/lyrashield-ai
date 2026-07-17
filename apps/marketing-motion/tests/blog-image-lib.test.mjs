import assert from "node:assert/strict"
import test from "node:test"
import {
  BLOG_IMAGE_OUTPUTS,
  buildCatalogEntry,
  collectImageDefinitions,
  outputPaths,
  qualitySequence,
  sha256,
  stableJson,
  validateSourceDimensions,
} from "../scripts/blog-image-lib.mjs"

test("builds all five output paths", () => {
  assert.deepEqual(Object.keys(outputPaths("access-boundary-01")), [
    "avif",
    "webp",
    "jpeg",
    "og",
    "socialPortrait",
  ])
  assert.deepEqual(outputPaths("access-boundary-01"), {
    avif: "/images/blog/library/access-boundary-01/hero.avif",
    webp: "/images/blog/library/access-boundary-01/hero.webp",
    jpeg: "/images/blog/library/access-boundary-01/hero.jpg",
    og: "/images/blog/library/access-boundary-01/og.jpg",
    socialPortrait: "/images/blog/library/access-boundary-01/social-portrait.jpg",
  })
})

test("rejects unsafe image identifiers", () => {
  assert.throws(() => outputPaths("../outside"), /image ID/i)
  assert.throws(() => outputPaths("Uppercase"), /image ID/i)
})

test("requires a square source at least 2048 pixels", () => {
  assert.deepEqual(validateSourceDimensions({ width: 2048, height: 2048 }), [])
  assert.deepEqual(validateSourceDimensions({ width: 4096, height: 4096 }), [])
  assert.match(validateSourceDimensions({ width: 1600, height: 900 })[0], /square/)
  assert.match(validateSourceDimensions({ width: 1024, height: 1024 })[0], /2048/)
  assert.match(validateSourceDimensions({ width: undefined, height: undefined })[0], /dimensions/)
})

test("builds deterministic descending quality sequences", () => {
  assert.deepEqual(qualitySequence(58, 46), [58, 56, 54, 52, 50, 48, 46])
  assert.deepEqual(qualitySequence(76, 66), [76, 74, 72, 70, 68, 66])
  assert.throws(() => qualitySequence(46, 58), /initial quality/i)
})

test("declares the required dimensions and byte budgets", () => {
  assert.deepEqual(
    BLOG_IMAGE_OUTPUTS.map(({ key, width, height, budgetBytes }) => ({
      key,
      width,
      height,
      budgetBytes,
    })),
    [
      { key: "avif", width: 1600, height: 900, budgetBytes: 220_000 },
      { key: "webp", width: 1600, height: 900, budgetBytes: 320_000 },
      { key: "jpeg", width: 1600, height: 900, budgetBytes: 320_000 },
      { key: "og", width: 1200, height: 630, budgetBytes: 350_000 },
      { key: "socialPortrait", width: 1080, height: 1350, budgetBytes: 350_000 },
    ]
  )
})

test("hashes and serializes generated records deterministically", () => {
  assert.equal(
    sha256(Buffer.from("abc")),
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  )
  assert.equal(stableJson({ imageCount: 0 }), '{\n  "imageCount": 0\n}\n')
})

test("deduplicates array manifest entries and rejects conflicting definitions", () => {
  const base = {
    slug: "first-post",
    imageId: "access-boundary-01",
    cluster: "access-control",
    alt: "Separate tenant chambers divided by a narrow translucent data gate",
  }
  const definitions = collectImageDefinitions([
    { file: "batch-1.json", entries: [base] },
    { file: "batch-2.json", entries: [{ ...base, slug: "second-post" }] },
  ])

  assert.equal(definitions.size, 1)
  assert.equal(definitions.get(base.imageId).usageCount, 2)
  assert.deepEqual(definitions.get(base.imageId).manifestFiles, ["batch-1.json", "batch-2.json"])

  assert.throws(
    () =>
      collectImageDefinitions([
        { file: "batch-1.json", entries: [base] },
        {
          file: "batch-2.json",
          entries: [{ ...base, slug: "second-post", cluster: "verification" }],
        },
      ]),
    /conflicting cluster/i
  )
  assert.throws(
    () =>
      collectImageDefinitions([
        { file: "batch-1.json", entries: [base] },
        {
          file: "batch-2.json",
          entries: [{ ...base, slug: "second-post", alt: "A different visible concept" }],
        },
      ]),
    /conflicting alt text/i
  )
  assert.throws(
    () => collectImageDefinitions([{ file: "object.json", entries: { images: [base] } }]),
    /top-level array/i
  )
  assert.throws(
    () => collectImageDefinitions([{ file: "invalid.json", entries: [{ ...base, alt: "" }] }]),
    /invalid alt/i
  )
})

test("builds the exact typed catalog shape", () => {
  assert.deepEqual(
    buildCatalogEntry({
      imageId: "access-boundary-01",
      cluster: "access-control",
      alt: "Separate tenant chambers divided by a narrow translucent data gate",
    }),
    {
      cluster: "access-control",
      ...outputPaths("access-boundary-01"),
      alt: "Separate tenant chambers divided by a narrow translucent data gate",
      width: 1600,
      height: 900,
    }
  )
})
