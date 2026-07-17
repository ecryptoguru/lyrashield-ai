import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_")
  const variant = mode === "portrait" ? "portrait" : "desktop"
  const outputVariant = env.VITE_OUTPUT_VARIANT || variant

  return {
    base: "./",
    publicDir: "public",
    build: {
      outDir: `dist/${outputVariant}`,
      emptyOutDir: true,
      assetsInlineLimit: 0,
    },
    define: {
      __COMPOSITION_ID__: JSON.stringify(process.env.VITE_COMP_ID || env.VITE_COMP_ID),
      __COMPOSITION_WIDTH__: JSON.stringify(
        Number(process.env.VITE_COMP_WIDTH || env.VITE_COMP_WIDTH)
      ),
      __COMPOSITION_HEIGHT__: JSON.stringify(
        Number(process.env.VITE_COMP_HEIGHT || env.VITE_COMP_HEIGHT)
      ),
    },
  }
})
