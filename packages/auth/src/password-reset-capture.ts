import { randomUUID } from "node:crypto"
/* eslint-disable security/detect-non-literal-fs-filename -- The sink validates an owned private temp directory before exclusively writing random fixture files. */
import { lstat, realpath, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { authTestMailConfigAllowed, env } from "@lyrashield/config"

/** Private filesystem fixture only: no mailbox route, token logging or live mail. */
export async function capturePasswordResetForTest(
  user: { email: string },
  url: string
): Promise<boolean> {
  const directory = env.LYRASHIELD_TEST_AUTH_MAIL_DIR
  if (!directory) return false
  if (
    process.env.NODE_ENV === "production" ||
    !authTestMailConfigAllowed({
      directory,
      ownedDirectory: env.LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR,
      nodeEnv: env.NODE_ENV,
      authUrl: env.BETTER_AUTH_URL,
      appUrl: env.NEXT_PUBLIC_APP_URL,
      databaseUrl: env.DATABASE_URL,
      databaseSystemUrl: env.DATABASE_SYSTEM_URL,
      brevoApiKey: env.BREVO_API_KEY,
      disposable: process.env.LYRASHIELD_TEST_DB_DISPOSABLE,
    })
  ) {
    throw new Error("auth_test_mail_capture_forbidden")
  }
  let reset: URL
  try {
    reset = new URL(url)
  } catch {
    throw new Error("auth_test_mail_capture_invalid_message")
  }
  if (
    !/^[^\s@]+@example\.test$/i.test(user.email) ||
    reset.origin !== new URL(env.BETTER_AUTH_URL).origin ||
    !/^\/api\/auth\/reset-password\/[^/]+$/.test(reset.pathname) ||
    reset.username ||
    reset.password ||
    url.length > 4096
  ) {
    throw new Error("auth_test_mail_capture_invalid_message")
  }
  const stat = await lstat(directory)
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    !/^lyrashield-auth-mail-[\w-]+$/.test(basename(directory)) ||
    (await realpath(dirname(directory))) !== (await realpath(tmpdir()))
  ) {
    throw new Error("auth_test_mail_capture_directory_unsafe")
  }
  const file = join(directory, `${randomUUID()}.json`)
  await writeFile(`${file}.tmp`, JSON.stringify({ email: user.email, url }), {
    flag: "wx",
    mode: 0o600,
  })
  await rename(`${file}.tmp`, file)
  return true
}
