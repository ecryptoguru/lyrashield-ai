/**
 * Test-only side effect: load the repo-root .env before `@lyrashield/config`
 * validates process.env at module evaluation. Import first in tests that
 * transitively pull in @lyrashield/db / @lyrashield/config.
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const rootEnv = resolve(here, "../../../../.env")
if (existsSync(rootEnv)) {
  try {
    process.loadEnvFile(rootEnv)
  } catch {
    /* env already loaded or malformed — tests decide */
  }
}
