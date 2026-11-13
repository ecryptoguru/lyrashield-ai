import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const marketingRoot = fileURLToPath(new URL("..", import.meta.url))

// Derive from the approved local catalog only. Generated renditions belong in
// dist, never in source control, and are recreated in production and preview.
export async function generateBlogResponsive(root = marketingRoot) {
  const catalog = JSON.parse(await readFile(resolve(root, "src/content/blog-images/images.json"), "utf8"))
  const jobs = Object.entries(catalog)
  let cursor = 0
  async function worker() {
    while (cursor < jobs.length) {
      const [id, image] = jobs[cursor++]
      if (!/^[a-z0-9-]+$/.test(id) || !image.jpeg.startsWith("/images/blog/library/")) {
        throw new Error("Invalid responsive blog catalog path")
      }
      const destination = resolve(root, "dist/client/images/blog/responsive", id)
      await mkdir(destination, { recursive: true })
      for (const width of [480, 960]) {
        const input = sharp(resolve(root, "public", image.jpeg.slice(1))).resize({ width, withoutEnlargement: true })
        await input.clone().webp({ quality: 78 }).toFile(resolve(destination, `hero-${width}.webp`))
        await input.clone().avif({ quality: 48, effort: 2 }).toFile(resolve(destination, `hero-${width}.avif`))
      }
    }
  }
  await Promise.all([worker(), worker()])
  console.log(`Responsive blog images: ${jobs.length} catalog entries, 480/960px AVIF and WebP.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateBlogResponsive()
}
