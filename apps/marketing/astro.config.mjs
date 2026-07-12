import { readFileSync } from "node:fs"
import { defineConfig, envField } from "astro/config"
import cloudflare from "@astrojs/cloudflare"
import mdx from "@astrojs/mdx"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"

// Astro resolves `site` and prerendered metadata during the build, before the
// Cloudflare Worker receives runtime vars. Keep those values in this one build
// configuration so sitemaps, canonical URLs, and indexing directives agree.
function wranglerVar(name) {
  try {
    const raw = readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8")
    const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""))
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

if (indexable) {
  try {
    const url = new URL(configuredSiteUrl)
    if (url.protocol !== "https:" || url.hostname === "localhost") throw new Error("not a public HTTPS URL")
  } catch {
    throw new Error("PUBLIC_SITE_URL must be a public HTTPS URL when PUBLIC_INDEXABLE=true")
  }
  if (!configuredAppUrl || configuredAppUrl === "http://localhost:3001") {
    throw new Error("PUBLIC_APP_URL must be set to the production app origin when PUBLIC_INDEXABLE=true")
  }
}

export default defineConfig({
  site: siteUrl,
  output: "static",
  trailingSlash: "never",
  adapter: cloudflare({
    imageService: "passthrough",
  }),
  integrations: [mdx(), sitemap()],
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
