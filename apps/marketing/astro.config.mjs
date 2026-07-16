import { readFileSync } from "node:fs"
import { defineConfig, envField } from "astro/config"
import cloudflare from "@astrojs/cloudflare"
import mdx from "@astrojs/mdx"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"
import { parseJsonc } from "./src/lib/jsonc"

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

const configuredSiteUrl = process.env.PUBLIC_SITE_URL || wranglerVar("PUBLIC_SITE_URL")
const siteUrl = configuredSiteUrl || "http://localhost:4321"
const indexable = (process.env.PUBLIC_INDEXABLE || wranglerVar("PUBLIC_INDEXABLE") || "false") === "true"
const xUrl = process.env.PUBLIC_X_URL || wranglerVar("PUBLIC_X_URL") || ""
const configuredAppUrl = process.env.PUBLIC_APP_URL || wranglerVar("PUBLIC_APP_URL")
const configuredScannerUrl = process.env.PUBLIC_SCANNER_URL || wranglerVar("PUBLIC_SCANNER_URL")
const turnstileSiteKey =
  process.env.PUBLIC_TURNSTILE_SITE_KEY || wranglerVar("PUBLIC_TURNSTILE_SITE_KEY") || ""
const abuseEmail = process.env.PUBLIC_ABUSE_EMAIL || wranglerVar("PUBLIC_ABUSE_EMAIL") || ""

if (indexable) {
  try {
    const url = new URL(configuredSiteUrl)
    if (url.protocol !== "https:" || url.hostname === "localhost") throw new Error("not a public HTTPS URL")
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
        default: "http://localhost:3001",
      }),
      PUBLIC_SCANNER_URL: envField.string({
        context: "client",
        access: "public",
        optional: true,
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
        default: "https://eu.i.posthog.com",
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
