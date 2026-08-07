import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

const readFile = vi.hoisted(() => vi.fn())
vi.mock("node:fs/promises", () => ({ readFile }))

import {
  CREDENTIALS_FILE,
  DEFAULT_API_URL,
  normalizeCredentials,
  readCredentialsFile,
  tryReadCredentialsFile,
  resolveCredentials,
} from "./index.js"

function enoent() {
  return Object.assign(new Error("not found"), { code: "ENOENT" })
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  readFile.mockReset()
  delete process.env.LYRASHIELD_API_KEY
  delete process.env.LYRASHIELD_API_URL
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("normalizeCredentials", () => {
  it("drops unknown keys and trims values", () => {
    const result = normalizeCredentials({
      apiKey: "  key  ",
      apiUrl: " https://example.test ",
      workspaceId: " ws ",
      installId: "install-1",
      // @ts-expect-error deliberately passing a stale field a hand-edited file could carry
      stale: "should not survive",
    })

    expect(result).toEqual({
      apiKey: "key",
      apiUrl: "https://example.test",
      workspaceId: "ws",
      installId: "install-1",
    })
    expect("stale" in result).toBe(false)
  })

  it("mints an installId when absent and drops whitespace-only values", () => {
    const result = normalizeCredentials({ apiKey: "   ", installId: "" })
    expect(result.installId).toMatch(/[0-9a-f-]{36}/)
    expect(result.apiKey).toBeUndefined()
  })
})

describe("readCredentialsFile", () => {
  it("returns undefined when the file does not exist", async () => {
    readFile.mockRejectedValueOnce(enoent())
    await expect(readCredentialsFile()).resolves.toBeUndefined()
  })

  it("throws an actionable error on malformed JSON without leaking the raw error", async () => {
    readFile.mockResolvedValueOnce("{ not json")
    await expect(readCredentialsFile()).rejects.toThrow(
      `${CREDENTIALS_FILE} is not valid JSON. Delete it and run: lyrashield login`
    )
  })

  it("throws an actionable error when the file is unreadable", async () => {
    readFile.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
    await expect(readCredentialsFile()).rejects.toThrow(/Check the file's permissions/)
  })
})

describe("tryReadCredentialsFile", () => {
  it("swallows a corrupt file so env vars can still win", async () => {
    readFile.mockResolvedValueOnce("{ not json")
    await expect(tryReadCredentialsFile()).resolves.toBeUndefined()
  })
})

describe("resolveCredentials", () => {
  it("prefers environment variables over the stored file", async () => {
    process.env.LYRASHIELD_API_KEY = "env-key"
    readFile.mockResolvedValueOnce(
      JSON.stringify({ apiKey: "file-key", apiUrl: "https://file.test", installId: "i" })
    )

    const resolved = await resolveCredentials()
    expect(resolved.apiKey).toBe("env-key")
    // apiUrl has no env override here, so the file value still applies.
    expect(resolved.apiUrl).toBe("https://file.test")
    expect(resolved.source).toBe("env")
  })

  it("falls back to the file, then to the default API URL", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ apiKey: "file-key", installId: "i" }))

    const resolved = await resolveCredentials()
    expect(resolved.apiKey).toBe("file-key")
    expect(resolved.apiUrl).toBe(DEFAULT_API_URL)
    expect(resolved.source).toBe("file")
  })

  it("reports source none when nothing is configured", async () => {
    readFile.mockRejectedValueOnce(enoent())

    const resolved = await resolveCredentials()
    expect(resolved.apiKey).toBeUndefined()
    expect(resolved.apiUrl).toBe(DEFAULT_API_URL)
    expect(resolved.source).toBe("none")
  })

  it("propagates a corrupt-file error by default but tolerates it when asked", async () => {
    readFile.mockResolvedValue("{ not json")

    await expect(resolveCredentials()).rejects.toThrow(/not valid JSON/)

    process.env.LYRASHIELD_API_KEY = "env-key"
    const tolerant = await resolveCredentials({ tolerateUnreadableFile: true })
    expect(tolerant.apiKey).toBe("env-key")
  })
})
