import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const config = vi.hoisted(() => ({
  LYRASHIELD_TEST_AUTH_MAIL_DIR: "",
  LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR: "",
  NODE_ENV: "test",
  BETTER_AUTH_URL: "http://127.0.0.1:3102",
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3102",
  DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test",
  DATABASE_SYSTEM_URL: "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test",
  BREVO_API_KEY: "",
}))
vi.mock("@lyrashield/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lyrashield/config")>()),
  env: config,
}))
import { capturePasswordResetForTest } from "./password-reset-capture"

const user = { email: "reset-fixture@example.test" }
const url =
  "http://127.0.0.1:3102/api/auth/reset-password/synthetic-token?callbackURL=/reset-password"
let directory: string

describe("private password-reset mail capture", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lyrashield-auth-mail-"))
    config.LYRASHIELD_TEST_AUTH_MAIL_DIR = directory
    config.LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR = directory
    config.NODE_ENV = "test"
    config.BREVO_API_KEY = ""
    config.BETTER_AUTH_URL = "http://127.0.0.1:3102"
    config.DATABASE_URL = "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test"
    config.DATABASE_SYSTEM_URL = "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test"
    vi.stubEnv("LYRASHIELD_TEST_DB_DISPOSABLE", "1")
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })

  it("does nothing with capture disabled", async () => {
    config.LYRASHIELD_TEST_AUTH_MAIL_DIR = ""
    expect(await capturePasswordResetForTest(user, url)).toBe(false)
    expect(await readdir(directory)).toEqual([])
  })

  it("captures only into private randomly named files", async () => {
    expect(await capturePasswordResetForTest(user, url)).toBe(true)
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    const file = join(directory, files[0]!)
    expect((await lstat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ email: user.email, url })
    expect(files[0]).not.toContain("synthetic-token")
  })

  it.each(["parsed", "process"])(
    "rejects production at the %s guard before writing",
    async (guard) => {
      if (guard === "parsed") config.NODE_ENV = "production"
      else vi.stubEnv("NODE_ENV", "production")
      await expect(capturePasswordResetForTest(user, url)).rejects.toThrow(
        "auth_test_mail_capture_forbidden"
      )
      expect(await readdir(directory)).toEqual([])
    }
  )

  it("refuses to capture when provider mail credentials are configured", async () => {
    config.BREVO_API_KEY = "synthetic-provider-key"
    await expect(capturePasswordResetForTest(user, url)).rejects.toThrow(
      "auth_test_mail_capture_forbidden"
    )
    expect(await readdir(directory)).toEqual([])
  })

  it("refuses a capture directory that is not owned by this browser-proof run", async () => {
    config.LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR = `${directory}-caller-owned`
    await expect(capturePasswordResetForTest(user, url)).rejects.toThrow(
      "auth_test_mail_capture_forbidden"
    )
    expect(await readdir(directory)).toEqual([])
  })

  it.each([
    [
      "DATABASE_URL",
      "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?host=remote.example",
    ],
    [
      "DATABASE_SYSTEM_URL",
      "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?hostaddr=198.51.100.8",
    ],
  ] as const)("refuses capture when %s can resolve to a remote host", async (name, value) => {
    config[name] = value
    await expect(capturePasswordResetForTest(user, url)).rejects.toThrow(
      "auth_test_mail_capture_forbidden"
    )
    expect(await readdir(directory)).toEqual([])
  })

  it.each([
    [{ email: "real@example.com" }, url],
    [user, "https://remote.example/api/auth/reset-password/synthetic-token"],
    [user, "http://127.0.0.1:3102/unrelated"],
    [user, "invalid-url"],
  ] as const)("refuses unsafe message %j", async (recipient, resetUrl) => {
    await expect(capturePasswordResetForTest(recipient, resetUrl)).rejects.toThrow(
      "auth_test_mail_capture_invalid_message"
    )
    expect(await readdir(directory)).toEqual([])
  })

  it("refuses a directory readable by other users", async () => {
    await chmod(directory, 0o755)
    await expect(capturePasswordResetForTest(user, url)).rejects.toThrow(
      "auth_test_mail_capture_directory_unsafe"
    )
    expect(await readdir(directory)).toEqual([])
  })

  it("refuses symlink directories", async () => {
    const link = `${directory}-link`
    await symlink(directory, link)
    config.LYRASHIELD_TEST_AUTH_MAIL_DIR = link
    config.LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR = link
    try {
      await expect(capturePasswordResetForTest(user, url)).rejects.toThrow(
        "auth_test_mail_capture_directory_unsafe"
      )
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(link)
    }
  })
})
