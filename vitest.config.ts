import { defineConfig } from "vitest/config"
import { existsSync } from "node:fs"
import { configureVitestDatabaseEnvironment } from "./.github/scripts/vitest-database-env.mjs"

if (existsSync(".env")) process.loadEnvFile(".env")

const disposableDatabaseTests = configureVitestDatabaseEnvironment(process.env)

const databaseIntegrationTests = [
  "**/*.runtime.test.ts",
  "packages/db/src/account-deletion.test.ts",
  "packages/db/src/api-key-rls.test.ts",
  "packages/db/src/artifact-deletion.test.ts",
  "packages/db/src/audit-concurrency.test.ts",
  "packages/db/src/scan-attachment-deletion.test.ts",
  "packages/db/src/soft-delete.test.ts",
  "packages/db/src/target-service.test.ts",
  "packages/integrations/src/**/*.redis.test.ts",
]

export default defineConfig({
  resolve: {
    alias: {
      "@/": new URL("./apps/web/src/", import.meta.url).pathname,
    },
  },
  test: {
    // Exclude build output and deps so compiled *.test.js copies in dist/ are
    // never discovered — otherwise a stray local/CI build inflates the run with
    // duplicate, stale tests. Source *.test.ts under apps/ and packages/ only.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/.worktrees/**",
      "e2e/**",
      "apps/marketing/**",
      "apps/marketing-motion/tests/**",
      // These use node:test and run in the ops suite, not Vitest.
      ".github/scripts/tests/**",
      ...(!disposableDatabaseTests ? databaseIntegrationTests : []),
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
    },
  },
})
