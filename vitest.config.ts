import { defineConfig } from "vitest/config"
import { existsSync } from "node:fs"

if (existsSync(".env")) process.loadEnvFile(".env")

export default defineConfig({
  test: {
    // Exclude build output and deps so compiled *.test.js copies in dist/ are
    // never discovered — otherwise a stray local/CI build inflates the run with
    // duplicate, stale tests. Source *.test.ts under apps/ and packages/ only.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.turbo/**", "e2e/**"],
  },
})
