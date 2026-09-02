import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Output } from "../output.js"
import { handleTargets } from "../commands/targets.js"

vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn(async () => ({
    apiKey: "lsk_fixture",
    apiUrl: "http://localhost:3000",
    workspaceId: "ws-test",
  })),
  requireWorkspace: vi.fn(() => "ws-test"),
}))

const target = { id: "target-1", type: "WEB_APP", url: "https://Staging.Example.com/path" }
const proof = {
  id: "proof-1",
  domain: "staging.example.com",
  method: "DNS_TXT",
  status: "PENDING",
  expiresAt: "2099-01-01T00:00:00.000Z",
}
const output: Output = {
  json: true,
  quiet: false,
  log: vi.fn(),
  notice: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  result: vi.fn(),
  fail: (error) => {
    throw new Error(error)
  },
}
const fetchMock = vi.fn()
function respond(data: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify(status >= 400 ? { success: false, error: data } : { success: true, data }),
      { status }
    )
  )
}
function targets(items: unknown[] = [target], nextCursor: string | null = null) {
  respond({ items, nextCursor })
}
function expectRequest(index: number, method: string, path: string, body?: unknown) {
  const call = fetchMock.mock.calls[index]!
  expect(call[0]).toBe(`http://localhost:3000/api/v1${path}`)
  expect(call[1].method).toBe(method)
  if (body) expect(JSON.parse(call[1].body)).toEqual(body)
}

describe("targets verify-domain", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())
  it("shows the current normalized domain status without mutation", async () => {
    targets()
    respond([proof])
    expect(await handleTargets(["verify-domain", "target-1"], output)).toBe(0)
    expectRequest(0, "GET", "/targets?workspaceId=ws-test")
    expectRequest(1, "GET", "/target-domain-verifications?workspaceId=ws-test")
    expect(output.result).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PENDING", domain: "staging.example.com" })
    )
  })
  it("issues a proof using the normalized target domain and workspace", async () => {
    targets()
    respond({
      verification: proof,
      dns: { host: "_lyrashield.staging.example.com", value: "fixture-only-token" },
    })
    expect(await handleTargets(["verify-domain", "target-1", "--issue"], output)).toBe(0)
    expectRequest(1, "POST", "/target-domain-verifications", {
      workspaceId: "ws-test",
      domain: "staging.example.com",
    })
    expect(output.result).toHaveBeenCalledWith(
      expect.objectContaining({
        dns: { host: "_lyrashield.staging.example.com", value: "fixture-only-token" },
      })
    )
  })
  it("checks only the selected domain's current proof", async () => {
    targets()
    respond([{ ...proof, id: "other", domain: "other.example.com" }, proof])
    respond({ ...proof, status: "VERIFIED" })
    expect(await handleTargets(["verify-domain", "target-1", "--check"], output)).toBe(0)
    expectRequest(2, "PUT", "/target-domain-verifications", {
      workspaceId: "ws-test",
      verificationId: "proof-1",
    })
  })
  it("follows target pagination without changing workspace", async () => {
    targets([], "next")
    targets()
    respond([])
    await handleTargets(["verify-domain", "target-1"], output)
    expectRequest(1, "GET", "/targets?workspaceId=ws-test&cursor=next")
  })
  it("rejects conflicting flags before issuing requests", async () => {
    await expect(
      handleTargets(["verify-domain", "target-1", "--issue", "--check"], output)
    ).rejects.toThrow("not both")
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([
    ["REPO", "https://example.com"],
    ["WEB_APP", "http://127.0.0.1"],
  ])("rejects unsupported targets or invalid domains: %s %s", async (type, url) => {
    targets([{ ...target, type, url }])
    await expect(handleTargets(["verify-domain", "target-1", "--issue"], output)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it("does not issue for a target outside this workspace", async () => {
    targets([])
    await expect(handleTargets(["verify-domain", "target-1", "--issue"], output)).rejects.toThrow(
      "selected workspace"
    )
  })
  it("reports expired verification and requires reissuance before checking", async () => {
    targets()
    respond([{ ...proof, status: "VERIFIED", expiresAt: "2000-01-01T00:00:00Z" }])
    await handleTargets(["verify-domain", "target-1"], output)
    expect(output.result).toHaveBeenCalledWith(expect.objectContaining({ status: "EXPIRED" }))
    targets()
    respond([{ ...proof, expiresAt: "2000-01-01T00:00:00Z" }])
    await expect(handleTargets(["verify-domain", "target-1", "--check"], output)).rejects.toThrow(
      "--issue first"
    )
  })
  it.each([403, 409])("propagates permission/DNS failures (%s) as errors", async (status) => {
    targets()
    respond([proof])
    respond({ code: "PROOF_FAILURE", message: "Proof failed" }, status)
    await expect(handleTargets(["verify-domain", "target-1", "--check"], output)).rejects.toThrow(
      "Proof failed"
    )
    expect(output.result).not.toHaveBeenCalled()
  })
  it("preserves existing list and create commands", async () => {
    targets()
    await handleTargets([], output)
    expectRequest(0, "GET", "/targets?workspaceId=ws-test")
    respond(target)
    await handleTargets(
      ["--name", "Site", "--type", "WEB_APP", "--url", "https://example.com"],
      output
    )
    expectRequest(1, "POST", "/targets", {
      workspaceId: "ws-test",
      name: "Site",
      type: "WEB_APP",
      url: "https://example.com",
    })
  })
})
