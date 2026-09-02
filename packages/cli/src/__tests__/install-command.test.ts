import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleInstall } from "../commands/install.js"
import type { Output } from "../output.js"
const mocks = vi.hoisted(() => ({
  credentials: vi.fn(),
  install: vi.fn(),
}))
vi.mock("../credentials.js", () => ({ getEffectiveCredentials: mocks.credentials }))
vi.mock("../installers/install.js", () => ({ installAgent: mocks.install }))
const output = {
  error: vi.fn(),
  log: vi.fn(),
  notice: vi.fn(),
  result: vi.fn(),
  json: false,
} as unknown as Output
beforeEach(() => {
  vi.clearAllMocks()
  mocks.credentials.mockResolvedValue({
    apiUrl: "https://app.lyrashieldai.com",
    credentialKind: "none",
  })
  mocks.install.mockResolvedValue({ outcome: "CONFIGURED" })
})
describe("plugin install transport", () => {
  it("defaults the hosted plugin to remote HTTP without a local credential", async () => {
    expect(await handleInstall(["claude-code-agent-plugin", "--dry-run"], output)).toBe(0)
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({ transport: "remote-http", dryRun: true })
    )
  })
  it("retains explicit transport selection for installer validation", async () => {
    await handleInstall(["claude-code-agent-plugin", "--transport", "stdio"], output)
    expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({ transport: "stdio" }))
  })
  it("requires local credentials for the Kiro stdio plugin", async () => {
    expect(await handleInstall(["kiro-agent-plugin"], output)).toBe(3)
    expect(mocks.install).not.toHaveBeenCalled()
  })
})
