import { getViteConfig } from "astro/config"

export default getViteConfig(
  {
    test: {
      include: ["src/**/*.test.ts"],
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
        __MARKETING_LOCAL_PREVIEW__: "false",
        __MARKETING_X_URL__: '""',
        __MARKETING_BUILD_REVISION__: '"0123456789abcdef0123456789abcdef01234567"',
        __MARKETING_GOOGLE_VERIFICATION__: '""',
        __MARKETING_BING_VERIFICATION__: '""',
      },
    },
  }
)
