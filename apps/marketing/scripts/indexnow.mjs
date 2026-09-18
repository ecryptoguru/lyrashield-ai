#!/usr/bin/env node

/**
 * Submit the live sitemap to IndexNow (Bing, Yandex, Seznam, Naver).
 *
 * Bing's index is what Microsoft Copilot answers from, so this is the one
 * off-site discovery signal that is fully in-repo. The protocol requires the
 * key to be hosted at the origin, which is why `public/<key>.txt` is committed
 * alongside this script and asserted by `src/tests/site-seo-gate.test.ts`.
 *
 * Non-fatal by design: a network failure or a non-2xx response must never fail
 * a release. The caller decides what to do with the exit code.
 *
 * Usage:
 *   node scripts/indexnow.mjs --origin https://lyrashieldai.com
 *   node scripts/indexnow.mjs --origin https://lyrashieldai.com --dry-run
 */

import { readFile } from "node:fs/promises"

const ENDPOINT = "https://api.indexnow.org/indexnow"
const MAX_URLS = 10_000

/** Must match the committed `public/<key>.txt` file. */
export const INDEXNOW_KEY = "a74cf3dd89f266a1c0b8d92a06c50f2b"

export function extractLocations(xml) {
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean)
}

async function sitemapUrls(origin, fetchImpl) {
  const indexUrl = `${origin}/sitemap-index.xml`
  const response = await fetchImpl(indexUrl)
  if (!response.ok) throw new Error(`${indexUrl} returned ${response.status}`)
  const xml = await response.text()

  const locations = extractLocations(xml)
  const nested = locations.filter((location) => location.endsWith(".xml"))
  if (nested.length === 0) return locations

  // Child sitemaps are fetched through the origin under test rather than the
  // absolute loc, so a local preview validates the build it is serving instead
  // of silently reading the live production sitemap.
  const urls = []
  for (const location of nested) {
    const childUrl = new URL(new URL(location, origin).pathname, origin).href
    const child = await fetchImpl(childUrl)
    if (!child.ok) throw new Error(`${childUrl} returned ${child.status}`)
    urls.push(...extractLocations(await child.text()))
  }
  return urls
}

export async function submitToIndexNow({ origin, fetchImpl = globalThis.fetch, dryRun = false }) {
  const fetchOrigin = new URL(origin).origin
  const urls = [...new Set(await sitemapUrls(fetchOrigin, fetchImpl))]
  if (urls.length === 0) throw new Error("the sitemap contained no URLs")

  // The submitted host and keyLocation come from the sitemap, not from the
  // origin this script fetched: a local `pnpm preview` serves a build whose
  // sitemap points at the production host, and IndexNow requires keyLocation to
  // live on the host being submitted.
  const hosts = new Set(urls.map((url) => new URL(url).host))
  if (hosts.size !== 1) throw new Error(`sitemap mixes hosts: ${[...hosts].join(", ")}`)
  const host = [...hosts][0]
  const protocol = new URL(urls[0]).protocol
  const keyLocation = `${protocol}//${host}/${INDEXNOW_KEY}.txt`

  // Verify the key is actually served before claiming anything to the provider.
  const keyResponse = await fetchImpl(`${fetchOrigin}/${INDEXNOW_KEY}.txt`)
  if (!keyResponse.ok) {
    throw new Error(`IndexNow key file ${keyLocation} returned ${keyResponse.status}`)
  }

  const urlList = urls.slice(0, MAX_URLS)
  if (dryRun) return { host, submitted: urlList.length, status: 0 }

  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation, urlList }),
  })
  return { host, submitted: urlList.length, status: response.status }
}

function argumentValue(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

async function main() {
  const args = process.argv.slice(2)
  const origin = argumentValue(args, "--origin")
  if (!origin) {
    console.error("Usage: node scripts/indexnow.mjs --origin https://lyrashieldai.com [--dry-run]")
    process.exitCode = 1
    return
  }

  try {
    const result = await submitToIndexNow({ origin, dryRun: args.includes("--dry-run") })
    console.log(
      args.includes("--dry-run")
        ? `IndexNow dry run: ${result.submitted} URL(s) on ${result.host} would be submitted.`
        : `IndexNow accepted ${result.submitted} URL(s) for ${result.host} (HTTP ${result.status}).`
    )
  } catch (error) {
    // Never fail the release: IndexNow is a discovery hint, not a gate.
    console.warn(`IndexNow submission skipped: ${error instanceof Error ? error.message : error}`)
  }
}

const invoked = process.argv[1]?.endsWith("indexnow.mjs")
if (invoked) {
  await main()
}
