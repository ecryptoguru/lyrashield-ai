import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, extname, relative } from "node:path"
import { defineConfig, envField } from "astro/config"
import cloudflare from "@astrojs/cloudflare"
import mdx from "@astrojs/mdx"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"
import { parseJsonc } from "./src/lib/jsonc"
import { tools } from "./src/lib/tools"

// Astro resolves `site` and prerendered metadata during the build, before the
// Cloudflare Worker receives runtime vars. Keep those values in this one build
// configuration so sitemaps, canonical URLs, and indexing directives agree.
function wranglerVar(name) {
  try {
    const raw = readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8")
    const json = parseJsonc(raw)
    return json.vars?.[name] || undefined
  } catch {
    return undefined
  }
}

// Real freshness signals only. Every sitemap entry previously carried just <loc>, so with
// 100+ posts crawlers had nothing to prioritise on. lastmod is emitted only where an actual
// date exists — stamping build time on every URL would claim the whole site changed on each
// deploy, which is worse than saying nothing.
function contentLastmod() {
  const map = new Map()

  // Blog posts: use updatedDate then pubDate.
  const blogDir = new URL("./src/content/blog/", import.meta.url)
  let files = []
  try {
    files = readdirSync(blogDir)
  } catch {
    // continue to other sources
  }
  for (const file of files) {
    if (!/\.(md|mdx)$/.test(file)) continue
    let frontmatter = ""
    try {
      frontmatter = readFileSync(new URL(file, blogDir), "utf8").split(/^---\s*$/m)[1] || ""
    } catch {
      continue
    }
    const pick = (key) => frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]
    const raw = (pick("updatedDate") || pick("pubDate") || "").trim().replace(/^["']|["']$/g, "")
    if (!raw) continue
    const date = new Date(raw)
    if (Number.isNaN(date.valueOf())) continue
    map.set(`/blog/${file.replace(/\.(md|mdx)$/, "")}`, date)
  }

  // Docs pages: parse updatedDate from the Astro frontmatter and map to the route.
  const docsDir = new URL("./src/pages/docs/", import.meta.url)
  function walkDocs(dir, basePath) {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = new URL(`${entry.name}`, dir)
      if (entry.isDirectory()) {
        walkDocs(new URL(`${entry.name}/`, dir), basePath)
      } else if (entry.isFile() && entry.name.endsWith(".astro")) {
        const content = readFileSync(child, "utf8")
        const match = content.match(/(?:const\s+updatedDate|dateModified)\s*=\s*["']([0-9]{4}-[0-9]{2}-[0-9]{2})["']/)
        if (!match) continue
        const date = new Date(match[1])
        if (Number.isNaN(date.valueOf())) continue
        const rel = relative(fileURLToPath(basePath), fileURLToPath(child))
          .replace(/\\/g, "/")
          .replace(/\.astro$/, "")
          .replace(/\/index$/, "")
        if (!rel) continue
        map.set(`/docs/${rel}`, date)
      }
    }
  }
  walkDocs(docsDir, docsDir)

  // Free tools: the registry now carries an updatedDate for every tool.
  const toolDate = tools[0]?.updatedDate ? new Date(tools[0].updatedDate) : undefined
  if (toolDate && !Number.isNaN(toolDate.valueOf())) {
    map.set("/tools", toolDate)
    for (const tool of tools) {
      if (tool.updatedDate) {
        const date = new Date(tool.updatedDate)
        if (!Number.isNaN(date.valueOf())) map.set(`/tools/${tool.slug}`, date)
      }
    }
  }

  return map
}

const LASTMOD = contentLastmod()

const configuredSiteUrl = process.env.PUBLIC_SITE_URL || wranglerVar("PUBLIC_SITE_URL")
const siteUrl = configuredSiteUrl || "http://localhost:4321"
const indexable =
  (process.env.PUBLIC_INDEXABLE || wranglerVar("PUBLIC_INDEXABLE") || "false") === "true"
const xUrl = process.env.PUBLIC_X_URL || wranglerVar("PUBLIC_X_URL") || ""
const configuredAppUrl = process.env.PUBLIC_APP_URL || wranglerVar("PUBLIC_APP_URL")
const configuredScannerUrl = process.env.PUBLIC_SCANNER_URL || wranglerVar("PUBLIC_SCANNER_URL")
const turnstileSiteKey =
  process.env.PUBLIC_TURNSTILE_SITE_KEY || wranglerVar("PUBLIC_TURNSTILE_SITE_KEY") || ""
const abuseEmail = process.env.PUBLIC_ABUSE_EMAIL || wranglerVar("PUBLIC_ABUSE_EMAIL") || ""

if (indexable) {
  try {
    const url = new URL(configuredSiteUrl)
    if (url.protocol !== "https:" || url.hostname === "localhost")
      throw new Error("not a public HTTPS URL")
  } catch {
    throw new Error("PUBLIC_SITE_URL must be a public HTTPS URL when PUBLIC_INDEXABLE=true")
  }
  if (configuredAppUrl) {
    try {
      const appUrl = new URL(configuredAppUrl)
      if (appUrl.protocol !== "https:" || appUrl.hostname === "localhost") {
        throw new Error("not a public HTTPS URL")
      }
    } catch {
      throw new Error("PUBLIC_APP_URL must be a public HTTPS URL when configured")
    }
  }
  if (configuredScannerUrl) {
    try {
      const scannerUrl = new URL(configuredScannerUrl)
      if (scannerUrl.protocol !== "https:" || scannerUrl.hostname === "localhost") {
        throw new Error("not a public HTTPS URL")
      }
    } catch {
      throw new Error("PUBLIC_SCANNER_URL must be a public HTTPS URL when configured")
    }
    if (!turnstileSiteKey) {
      throw new Error("PUBLIC_TURNSTILE_SITE_KEY must be set when the public scanner is enabled")
    }
    if (!abuseEmail || !abuseEmail.includes("@")) {
      throw new Error("PUBLIC_ABUSE_EMAIL must be set when the public scanner is enabled")
    }
  }
}

export default defineConfig({
  site: siteUrl,
  output: "static",
  trailingSlash: "never",
  redirects: {
    "/resources": "/blog",
    "/docs": "/docs/integrations",
    "/how-it-works": "/#how-it-works",
  },
  build: {
    inlineStylesheets: "always",
  },
  adapter: cloudflare({
    imageService: "passthrough",
  }),
  integrations: [
    mdx(),
    sitemap({
      filter: (page) => {
        const pathname = new URL(page).pathname
        return pathname !== "/terms" && (Boolean(configuredScannerUrl) || pathname !== "/scan")
      },
      serialize: (item) => {
        const pathname = new URL(item.url).pathname.replace(/\/$/, "")
        const lastmod = LASTMOD.get(pathname)
        return lastmod ? { ...item, lastmod: lastmod.toISOString() } : item
      },
    }),
  ],
  env: {
    validateSecrets: false,
    schema: {
      PUBLIC_SITE_URL: envField.string({
        context: "client",
        access: "public",
        default: "http://localhost:4321",
      }),
      PUBLIC_APP_URL: envField.string({
        context: "client",
        access: "public",
        default: "http://localhost:3000",
      }),
      PUBLIC_SCANNER_URL: envField.string({
        context: "client",
        access: "public",
        optional: true,
      }),
      PUBLIC_MEDIA_URL: envField.string({
        context: "client",
        access: "public",
        default: "/media-local",
      }),
      PUBLIC_MOTION_RENDER_HASH: envField.string({
        context: "client",
        access: "public",
        default: "local",
      }),
      PUBLIC_X_URL: envField.string({
        context: "client",
        access: "public",
        optional: true,
      }),
      PUBLIC_INDEXABLE: envField.string({
        context: "client",
        access: "public",
        default: "false",
      }),
      PUBLIC_POSTHOG_KEY: envField.string({
        context: "client",
        access: "public",
        optional: true,
      }),
      PUBLIC_POSTHOG_HOST: envField.string({
        context: "client",
        access: "public",
        default: "https://us.i.posthog.com",
      }),
      PUBLIC_TURNSTILE_SITE_KEY: envField.string({
        context: "client",
        access: "public",
        optional: true,
      }),
      PUBLIC_ABUSE_EMAIL: envField.string({
        context: "client",
        access: "public",
        optional: true,
      }),
      WAITLIST_IP_SALT: envField.string({
        context: "server",
        access: "secret",
        optional: true,
      }),
    },
  },
  vite: {
    plugins: [tailwindcss()],
    define: {
      __MARKETING_INDEXABLE__: JSON.stringify(indexable),
      __MARKETING_X_URL__: JSON.stringify(xUrl),
    },
  },
})
