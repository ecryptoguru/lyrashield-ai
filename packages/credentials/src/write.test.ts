/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

const home = vi.hoisted(() => ({ path: "" }))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.path,
}))

beforeAll(async () => {
  home.path = await mkdtemp(path.join(tmpdir(), "lyrashield-credential-writes-"))
})
afterAll(async () => {
  await rm(home.path, { recursive: true, force: true })
})

it("atomically persists concurrent writers without collisions or partial JSON", async () => {
  const { writeCredentialsFile, CREDENTIALS_FILE, CREDENTIALS_DIR } = await import("./index.js")
  const credentials = Array.from({ length: 20 }, (_, index) => ({
    installId: `writer-${index}`,
    apiKey: `synthetic-${index}-${"x".repeat(index * 100)}`,
  }))
  await Promise.all(credentials.map(writeCredentialsFile))
  expect(credentials).toContainEqual(JSON.parse(await readFile(CREDENTIALS_FILE, "utf8")))
  expect(await readdir(CREDENTIALS_DIR)).toEqual(["credentials.json"])
  if (process.platform !== "win32") {
    expect((await stat(CREDENTIALS_FILE)).mode & 0o777).toBe(0o600)
  }
})

it("cleans its temporary file when atomic replacement fails", async () => {
  const { writeCredentialsFile, CREDENTIALS_FILE, CREDENTIALS_DIR } = await import("./index.js")
  await rm(CREDENTIALS_FILE, { force: true })
  await mkdir(CREDENTIALS_FILE)
  await expect(writeCredentialsFile({ installId: "failed-write" })).rejects.toThrow()
  expect(await readdir(CREDENTIALS_DIR)).toEqual(["credentials.json"])
})
