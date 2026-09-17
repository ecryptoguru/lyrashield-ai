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

  const urls = []
  for (const sitemap of nested) {
    const child = await fetchImpl(sitemap)
    if (!child.ok) throw new Error(`${sitemap} returned ${child.status}`)
    urls.push(...extractLocations(await child.text()))
  }
  return urls
}

export async function submitToIndexNow({ origin, fetchImpl = globalThis.fetch, dryRun = false }) {
  const host = new URL(origin).host
  const keyLocation = `${origin}/${INDEXNOW_KEY}.txt`

  const keyResponse = await fetchImpl(keyLocation)
  if (!keyResponse.ok) {
    throw new Error(`IndexNow key file ${keyLocation} returned ${keyResponse.status}`)
  }

  const urls = await sitemapUrls(origin, fetchImpl)
  const urlList = [...new Set(urls)].filter((url) => new URL(url).host === host).slice(0, MAX_URLS)
  if (urlList.length === 0) throw new Error("no same-host URLs found in the sitemap")

  if (dryRun) return { submitted: urlList.length, status: 0 }

  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation, urlList }),
  })
  return { submitted: urlList.length, status: response.status }
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
        ? `IndexNow dry run: ${result.submitted} URL(s) would be submitted.`
        : `IndexNow accepted ${result.submitted} URL(s) (HTTP ${result.status}).`
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
