import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Output } from "../output.js"

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawn: spawnMock }))
vi.mock("../oauth-login.js", () => ({
  loginWithOAuth: async (_url: string, _output: Output, open: (url: string) => Promise<void>) => {
    await open("https://app.example.com/authorize?state=test")
    return 0
  },
}))
import { handleLogin } from "../commands/login.js"

const platform = Object.getOwnPropertyDescriptor(process, "platform")!
afterEach(() => {
  Object.defineProperty(process, "platform", platform)
  vi.clearAllMocks()
})

describe("OAuth browser launch", () => {
  it.each([
    ["darwin", "open", ["https://app.example.com/authorize?state=test"]],
    ["linux", "xdg-open", ["https://app.example.com/authorize?state=test"]],
    [
      "win32",
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", "https://app.example.com/authorize?state=test"],
    ],
  ])(
    "uses a shell-free %s launcher and tolerates an unavailable desktop",
    async (os, command, args) => {
      Object.defineProperty(process, "platform", { value: os, configurable: true })
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
      spawnMock.mockReturnValue(child)
      expect(await handleLogin(["--oauth"], {} as Output)).toBe(0)
      expect(spawnMock).toHaveBeenCalledWith(command, args, { detached: true, stdio: "ignore" })
      expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow()
      expect(child.unref).toHaveBeenCalledOnce()
    }
  )
})

describe("login --key removal (VULN-E-002)", () => {
  it.each([["--key", "lsk_x"], ["-k", "lsk_x"], ["--key=lsk_x"]])(
    "rejects %s without ever reading the credential value",
    async (...args) => {
      const output = {
        error: vi.fn(),
        log: vi.fn(),
        notice: vi.fn(),
        warn: vi.fn(),
      } as unknown as Output

      const exitCode = await handleLogin(args, output)

      expect(exitCode).toBe(2)
      expect(output.error).toHaveBeenCalledWith(expect.stringContaining("exposes your API key"))
      // Never reaches stdin/prompt/credential storage.
      expect(output.log).not.toHaveBeenCalled()
    }
  )
})
