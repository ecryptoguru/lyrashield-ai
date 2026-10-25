import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { buildEngineEnv } from "./runner-config"

beforeEach(() => vi.stubEnv("LYRASHIELD_ENGINE_SANDBOX_NETWORK", "test-restricted-egress"))
afterEach(() => vi.unstubAllEnvs())

const profile = {
  model: "azure_ai/gpt-6-luna",
  reasoningEffort: "medium" as const,
  delegateReasoningEffort: "high" as const,
}
const token = randomUUID()
const options = { runType: "repository", repositoryAuth: { repoFullName: "owner/private", token } }

describe("scan-local private repository Git credentials", () => {
  it("authenticates only the exact repository without putting credentials in its URL", () => {
    const environment = buildEngineEnv(profile, undefined, options)
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0")
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1")
    expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null")
    const gitEnv = { ...process.env, ...environment }
    const value = execFileSync(
      "git",
      ["config", "--get-urlmatch", "http.extraheader", "https://github.com/owner/private.git"],
      { env: gitEnv, encoding: "utf8" }
    )
    expect(value.trim()).toBe(
      `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
    )
    for (const url of [
      "https://github.com/owner/other.git",
      "https://github.com/owner/private-extra.git",
      "https://example.com/owner/private.git",
    ])
      expect(() =>
        execFileSync("git", ["config", "--get-urlmatch", "http.extraheader", url], {
          env: gitEnv,
          stdio: "pipe",
        })
      ).toThrow()
    expect(
      execFileSync("git", ["config", "--get", "http.followRedirects"], {
        env: gitEnv,
        encoding: "utf8",
      }).trim()
    ).toBe("false")
  })
  it("does not inherit ambient credentials into unrelated runs", () => {
    vi.stubEnv("GIT_CONFIG_COUNT", "1")
    vi.stubEnv("GIT_CONFIG_KEY_0", "http.extraheader")
    vi.stubEnv("GIT_CONFIG_VALUE_0", token)
    try {
      expect(buildEngineEnv(profile).GIT_CONFIG_VALUE_0).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it.each(["../private", "owner/private/extra", "owner/private\nheader"])(
    "rejects an invalid repository identity %s",
    (repoFullName) => {
      expect(() =>
        buildEngineEnv(profile, undefined, { ...options, repositoryAuth: { repoFullName, token } })
      ).toThrow()
    }
  )
  it("rejects header injection and credentials on URL runs", () => {
    expect(() =>
      buildEngineEnv(profile, undefined, {
        ...options,
        repositoryAuth: { ...options.repositoryAuth, token: "bad\nheader" },
      })
    ).toThrow()
    expect(() =>
      buildEngineEnv(profile, undefined, { ...options, runType: "web_application" })
    ).toThrow()
  })
})
