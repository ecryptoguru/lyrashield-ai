import { describe, expect, it, vi } from "vitest"
import { regenerateComposerLock } from "./composer-fix"
import { composerContentHash } from "../engine/scanners/composer-dependencies"

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const manifest = {
  name: "lyrashield/fixture",
  description: "Offline resolver fixture",
  license: "MIT",
  require: { "psr/log": "^1.1" },
}
const oldPackage = {
  name: "psr/log",
  version: "1.1.3",
  type: "library",
  require: { php: ">=5.3.0" },
}
const nextPackage = { ...oldPackage, version: "1.1.4" }
const originalManifest = JSON.stringify(manifest, null, 4) + "\n"
const originalLock =
  JSON.stringify(
    {
      _readme: ["Generated fixture"],
      "content-hash": composerContentHash(manifest),
      packages: [oldPackage],
      "packages-dev": [],
      aliases: [],
      "minimum-stability": "stable",
      "stability-flags": {},
      "prefer-stable": false,
      "prefer-lowest": false,
      platform: [],
      "platform-dev": [],
      "plugin-api-version": "2.9.0",
    },
    null,
    4
  ) + "\n"
const request = {
  originalManifest,
  originalLock,
  packageName: "psr/log",
  fromVersion: "1.1.3",
  toVersion: "1.1.4",
}
const fakeMetadataFetch = async () =>
  new Response(JSON.stringify({ packages: { "psr/log": [nextPackage] } }), {
    headers: { "content-type": "application/json" },
  })

describe("offline Composer update boundary", () => {
  it("rejects target-controlled repositories before contacting any server", async () => {
    await expect(
      regenerateComposerLock({
        ...request,
        originalManifest: JSON.stringify({
          ...manifest,
          repositories: [{ type: "composer", url: "http://169.254.169.254" }],
        }),
      })
    ).rejects.toThrow(/repositories/i)
  })
  it("rejects stale locks rather than fixing an assumed installation", async () => {
    await expect(
      regenerateComposerLock({
        ...request,
        originalLock: originalLock.replace(composerContentHash(manifest), "a".repeat(32)),
      })
    ).rejects.toThrow(/hash|stale/i)
  })
  it("rejects package and release arguments before launching a process", async () => {
    await expect(regenerateComposerLock({ ...request, packageName: "--evil" })).rejects.toThrow()
    await expect(regenerateComposerLock({ ...request, toVersion: "dev-main" })).rejects.toThrow()
  })
  it("rejects cancellation before metadata I/O", async () => {
    await expect(
      regenerateComposerLock({ ...request, signal: AbortSignal.abort() })
    ).rejects.toThrow()
  })
  it("does not accept a different package from the official metadata endpoint", async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          package: {
            name: "other/pkg",
            versions: { "1.1.4": { ...nextPackage, name: "other/pkg" } },
          },
        })
      )
    await expect(
      regenerateComposerLock({
        ...request,
        fetchFn: fetchFn as typeof fetch,
        resolver: async () => ["93.184.216.34"],
      })
    ).rejects.toThrow(/metadata|package/i)
  })
  it.runIf(process.env.LYRASHIELD_COMPOSER_SMOKE === "1")(
    "regenerates and validates a real lock with networking, plugins, scripts and installation disabled",
    async () => {
      const result = await regenerateComposerLock({
        ...request,
        originalManifest: JSON.stringify({
          ...manifest,
          scripts: { "post-update-cmd": "@php -r 'exit(66);'" },
        }),
        fetchFn: fakeMetadataFetch as typeof fetch,
        resolver: async () => ["93.184.216.34"],
      })
      const lock = JSON.parse(result.after)
      expect(lock.packages).toEqual([nextPackage])
      expect(lock["content-hash"]).toBe(composerContentHash(manifest))
      expect(result.checks).toEqual({
        network: "none",
        scripts: false,
        plugins: false,
        install: false,
        lockValidated: true,
      })
    },
    120_000
  )
})
