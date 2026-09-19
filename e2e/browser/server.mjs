import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

// Reuse Vitest's Vite runtime; this harness adds no dependency or application route.
const require = createRequire(import.meta.url)
const vitestRequire = createRequire(require.resolve("vitest/package.json"))
const { createServer } = await import(vitestRequire.resolve("vite"))
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const marketingRequire = createRequire(
  new URL("../../apps/marketing/package.json", import.meta.url)
)
const { default: tailwindcss } = await import(marketingRequire.resolve("@tailwindcss/vite"))
const server = await createServer({
  plugins: [tailwindcss()],
  configFile: false,
  root: fileURLToPath(new URL("../../", import.meta.url)),
  resolve: {
    alias: {
      "@/": fileURLToPath(new URL("../../apps/web/src/", import.meta.url)),
      "@lyrashield/ui": fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)),
      "react-dom/client": webRequire.resolve("react-dom/client"),
      "react/jsx-runtime": webRequire.resolve("react/jsx-runtime"),
      "react/jsx-dev-runtime": webRequire.resolve("react/jsx-dev-runtime"),
      react: webRequire.resolve("react"),
    },
    dedupe: ["react", "react-dom"],
  },
  oxc: { jsx: { runtime: "automatic" } },
  server: { host: "127.0.0.1", port: 3101, strictPort: true },
})
await server.listen()
