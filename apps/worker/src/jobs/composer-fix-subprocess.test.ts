import { beforeEach, describe, expect, it, vi } from "vitest"

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile: execFileMock }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { ComposerFixUnavailableError, regenerateComposerLock } from "./composer-fix"
import { composerContentHash } from "../engine/scanners/composer-dependencies"

const manifest = { name: "lyrashield/fixture", require: { "psr/log": "^1.1" } }
const originalPackage = { name: "psr/log", version: "1.1.3", type: "library" }
const request = {
  originalManifest: JSON.stringify(manifest),
  originalLock: JSON.stringify({
    "content-hash": composerContentHash(manifest),
    packages: [originalPackage],
    "packages-dev": [],
  }),
  packageName: "psr/log",
  fromVersion: "1.1.3",
  toVersion: "1.1.4",
  fetchFn: async () =>
    new Response(
      JSON.stringify({ packages: { "psr/log": [{ ...originalPackage, version: "1.1.4" }] } })
    ),
  resolver: async () => ["93.184.216.34"],
}

type ProcessFailure = Error & { code?: string | number | null; killed?: boolean; signal?: string }
function failResolution(failure: ProcessFailure, beforeFailure?: () => void): void {
  execFileMock.mockImplementation((_file, args, _options, callback) => {
    if (args[0] === "run") {
      beforeFailure?.()
      callback(failure, "", "")
    } else callback(null, "", "")
  })
}

beforeEach(() => {
  execFileMock.mockReset()
})

describe("isolated Composer subprocess failure classification", () => {
  it.each([
    { code: 1 },
    { code: 125 },
    { code: 126 },
    { code: 127 },
    { code: 137 },
    { code: "ENOENT" },
    { code: null, killed: true, signal: "SIGTERM" },
    { code: 1, killed: true, signal: "SIGKILL" },
    { code: 42, killed: true, signal: "SIGTERM" },
  ])("keeps Docker/launch/killed failures retryable (%j)", async (details) => {
    failResolution(Object.assign(new Error("subprocess failure"), details))
    const failure = await regenerateComposerLock(request).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(ComposerFixUnavailableError)
  })

  it("settles only the worker-owned Composer constraint exit status as unavailable", async () => {
    failResolution(Object.assign(new Error("Composer constraints"), { code: 42 }))
    await expect(regenerateComposerLock(request)).rejects.toBeInstanceOf(
      ComposerFixUnavailableError
    )
  })

  it("preserves cancellation during resolution instead of classifying the subprocess exit", async () => {
    const controller = new AbortController()
    const reason = new Error("Cancelled by operator")
    failResolution(Object.assign(new Error("subprocess interrupted"), { code: 1 }), () =>
      controller.abort(reason)
    )
    await expect(regenerateComposerLock({ ...request, signal: controller.signal })).rejects.toBe(
      reason
    )
  })
})

// Exercise the actual worker-owned PHP wrapper with a test-owned Composer stand-in.
// Only the module's process boundary is mocked; production accepts no subprocess hook.
it.runIf(process.env.LYRASHIELD_COMPOSER_SMOKE === "1").each([
  [0, false],
  [1, true],
  [2, true],
  [42, false],
  [127, false],
  [137, false],
  [143, false],
])(
  "classifies actual Composer child status %s (terminal=%s)",
  async (status, terminal) => {
    const { execFile } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process")
    const { promisify } = await import("node:util")
    const { writeFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const run = promisify(execFile)
    execFileMock.mockImplementation((_file, args: string[], options, callback) => {
      if (args[0] !== "run") {
        callback(null, "", "")
        return
      }
      const mount = args.find((argument) => argument.startsWith("type=bind,source="))!
      const root = mount.slice("type=bind,source=".length).split(",target=")[0]!
      const actualArgs = [...args]
      actualArgs.splice(
        actualArgs.indexOf("--entrypoint"),
        0,
        "-e",
        "PATH=/app:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
      )
      void writeFile(join(root, "composer"), `#!/bin/sh\nexit ${status}\n`, { mode: 0o700 })
        .then(() => run("docker", actualArgs, options))
        .then(
          ({ stdout, stderr }) => callback(null, stdout, stderr),
          (error: unknown) => callback(error, "", "")
        )
    })
    const result = await regenerateComposerLock(request).catch((error: unknown) => error)
    if (terminal) expect(result).toBeInstanceOf(ComposerFixUnavailableError)
    else if (status !== 0) {
      expect(result).toBeInstanceOf(Error)
      expect(result).not.toBeInstanceOf(ComposerFixUnavailableError)
    } else expect(result).toMatchObject({ checks: { lockValidated: true } })
  },
  120_000
)
