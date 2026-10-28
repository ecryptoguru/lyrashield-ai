import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { generateBlogResponsive } from "./generate-blog-responsive.mjs"

test("responsive build creates usable, dimensioned AVIF and WebP candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "lyrashield-responsive-test-"))
  try {
    await mkdir(join(root, "src/content/blog-images"), { recursive: true })
    await mkdir(join(root, "public/images/blog/library/example"), { recursive: true })
    await writeFile(join(root, "src/content/blog-images/images.json"), JSON.stringify({ example: { jpeg: "/images/blog/library/example/hero.jpg" } }))
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#102235" } }).jpeg().toFile(join(root, "public/images/blog/library/example/hero.jpg"))
    await generateBlogResponsive(root)
    for (const width of [480, 960]) {
      for (const extension of ["avif", "webp"]) {
        const metadata = await sharp(join(root, `dist/client/images/blog/responsive/example/hero-${width}.${extension}`)).metadata()
        assert.equal(metadata.width, width)
        assert.equal(metadata.height, width * 9 / 16)
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
