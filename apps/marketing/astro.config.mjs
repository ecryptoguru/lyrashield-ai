import { readFileSync } from "node:fs"
import { defineConfig, envField } from "astro/config"
import cloudflare from "@astrojs/cloudflare"
import mdx from "@astrojs/mdx"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"

// The Cloudflare adapter (v14+) feeds `vars` from wrangler.jsonc into
// import.meta.env / astro:env at build time — but Astro's own `site` config is
// resolved HERE, from process.env, before the adapter runs. If the two sources
// disagree, sitemap/RSS/llms.txt URLs (driven by `site`) diverge from
// canonical/robots URLs (driven by import.meta.env). Fall back to the wrangler
// vars so wrangler.jsonc is the single source of truth; a PUBLIC_SITE_URL
// shell env var still wins when explicitly set (e.g. one-off preview builds).
function wranglerVar(name) {
  try {
    const raw = readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8")
    const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""))
    return json.vars?.[name] || undefined
  } catch {
    return undefined
  }
}

const siteUrl = process.env.PUBLIC_SITE_URL || wranglerVar("PUBLIC_SITE_URL") || "http://localhost:4321"

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
  },
})
