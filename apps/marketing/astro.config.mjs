import { defineConfig, envField } from "astro/config"
import cloudflare from "@astrojs/cloudflare"
import mdx from "@astrojs/mdx"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"

const siteUrl = process.env.PUBLIC_SITE_URL || "http://localhost:4321"

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
