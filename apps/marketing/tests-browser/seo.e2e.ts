import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { runSiteGate } from "../scripts/crawl-built-site.mjs"

/**
 * Site-wide SEO/AEO gate.
 *
 * `crawl-built-blog.mjs` covers /blog only and is a manual pre-release crawl;
 * this runs on every marketing change because it reuses the Playwright
 * webServer that already boots `pnpm preview` (astro build + wrangler dev), so
 * it asserts against the exact built Worker rather than the source.
 *
 * Known violations are pinned in `scripts/seo-baseline.json` and the gate fails
 * on anything not listed there. Stale entries are reported so the allowlist
 * drains instead of rotting.
 */
const baselinePath = fileURLToPath(new URL("../scripts/seo-baseline.json", import.meta.url))

// The crawl fetches every sitemap URL, so it runs once and both assertions read
// the same result rather than re-crawling.
let cached: Promise<Awaited<ReturnType<typeof runSiteGate>>> | undefined

test.beforeAll(async ({ baseURL }) => {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"))
  cached = runSiteGate({ origin: baseURL!, baseline })
})

test("every sitemap URL satisfies the site SEO gate", async () => {
  const result = await cached!

  const report = result.fresh
    .map((v) => `${v.rule}: ${v.path}${v.detail ? ` — ${v.detail}` : ""}`)
    .join("\n")

  expect(result.fresh, `new SEO violations:\n${report}`).toHaveLength(0)
  expect(result.pageCount, "the sitemap should cover the whole public surface").toBeGreaterThan(200)
})

test("the baseline stays an accurate record of known violations", async () => {
  const result = await cached!

  // A stale entry means the violation was fixed but the allowlist still claims
  // it exists. Failing here forces the baseline to be regenerated with
  // `node scripts/crawl-built-site.mjs --origin <url> --write-baseline`, which
  // is how each wave drains its own entries.
  const stale = result.stale.map(([rule, path]) => `${rule}: ${path}`).join("\n")
  expect(result.stale, `stale baseline entries — regenerate the baseline:\n${stale}`).toHaveLength(
    0
  )
})
