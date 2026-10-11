import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  cleanupOwnedAuthTestMailDirectory,
  createOwnedAuthTestMailDirectory,
} from "../../packages/auth/src/auth-test-mail-directory.ts"
import { isSafeDisposableDatabaseUrl } from "../../packages/config/src/auth-test-mail.ts"

const childEnvironment = { ...process.env }
if (childEnvironment.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") {
  throw new Error("Auth mail browser proof requires an explicit disposable database")
}
if (childEnvironment.DEBUG || childEnvironment.PWDEBUG || childEnvironment.PW_TEST_DEBUG) {
  throw new Error("Auth mail browser proof must run without debug logging")
}
if (childEnvironment.NODE_ENV === "production" || childEnvironment.BREVO_API_KEY) {
  throw new Error("Auth mail browser proof requires a non-production app without mail credentials")
}
for (const name of ["DATABASE_URL", "DATABASE_SYSTEM_URL"]) {
  if (!isSafeDisposableDatabaseUrl(childEnvironment[name])) {
    throw new Error("Auth mail browser proof requires named loopback test databases")
  }
}

// Ignore caller-supplied paths. Playwright reloads its config in worker processes,
// so directory creation belongs in this one-shot runner, outside the config.
createOwnedAuthTestMailDirectory(childEnvironment)
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
let child
let exitCode = 1
const forwardSignal = (signal) => child?.kill(signal)
process.once("SIGINT", forwardSignal)
process.once("SIGTERM", forwardSignal)

try {
  child = spawn(
    "pnpm",
    ["exec", "playwright", "test", "-c", "e2e/auth-mail/playwright.config.ts"],
    { cwd: repoRoot, env: childEnvironment, stdio: "inherit" }
  )
  exitCode = await new Promise((resolve) => {
    child.once("error", () => {
      console.error("Unable to start the auth mail browser proof")
      resolve(127)
    })
    child.once("close", (code) => resolve(code ?? 1))
  })
} finally {
  process.off("SIGINT", forwardSignal)
  process.off("SIGTERM", forwardSignal)
  await cleanupOwnedAuthTestMailDirectory(
    childEnvironment.LYRASHIELD_TEST_AUTH_MAIL_DIR,
    childEnvironment.LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR
  )
}

process.exitCode = exitCode
