import { getViteConfig } from "astro/config"

export default getViteConfig(
  {
    test: {
      exclude: ["**/node_modules/**", "**/dist/**"],
    },
  },
  {
    configFile: false,
    root: new URL(".", import.meta.url),
    site: "https://lyrashieldai.com",
    vite: {
      define: {
        __MARKETING_INDEXABLE__: "true",
        __MARKETING_X_URL__: '""',
      },
    },
  }
)
