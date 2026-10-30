import { describe, expect, it, vi } from "vitest"
import { GoMetadataBroker, missingGoMetadataPaths } from "./go-metadata-broker"
const ok = (html: string, status = 200, headers: Record<string, string> = {}) => ({
  ok: true as const,
  result: {
    html,
    status,
    headers,
    bodyBytes: Buffer.byteLength(html),
    bodyTruncated: false,
    finalUrl: "",
    urlHistory: [],
  },
})
describe("scoped Go metadata broker", () => {
  it("accepts only exact module metadata and rejects traversal, zip, mutable and hosts", async () => {
    const fetch = vi.fn(async () => ok("module example.org/a\n"))
    const broker = new GoMetadataBroker(Date.now() + 90000, undefined, fetch)
    for (const path of [
      "../secret",
      "example.org/a/@v/latest.mod",
      "example.org/a/@v/v1.0.0.zip",
      "https://evil.test/a/@v/v1.0.0.mod",
      "example.org/%2e%2e/@v/v1.0.0.mod",
      "example.org/a/@v/list",
      "example.org/a/@v/v1.0.0.mod?x=1",
    ])
      await expect(broker.get(path)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    await expect(broker.get("example.org/a/@v/v1.0.0.mod")).resolves.toContain("module")
    expect(fetch.mock.calls[0]?.[0]).toBe("https://proxy.golang.org/example.org/a/@v/v1.0.0.mod")
  })
  it("rejects redirects before contacting their target", async () => {
    const fetch = vi.fn(async () =>
      ok("", 302, { location: "http://169.254.169.254/latest/meta-data" })
    )
    await expect(
      new GoMetadataBroker(Date.now() + 90000, undefined, fetch).get("example.org/a/@v/v1.0.0.mod")
    ).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("enforces shared deadline, checksum evidence, caching and module limit", async () => {
    const fetch = vi.fn(async () => ok("module example.org/a\n"))
    const broker = new GoMetadataBroker(Date.now() + 90000, undefined, fetch)
    await broker.get("example.org/a/@v/v1.0.0.mod")
    await broker.get("example.org/a/@v/v1.0.0.mod")
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(broker.receipts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
    await expect(
      new GoMetadataBroker(Date.now() - 1, undefined, fetch).get("example.org/a/@v/v1.0.0.mod")
    ).rejects.toThrow()
    const limited = new GoMetadataBroker(Date.now() + 90000, undefined, fetch, {
      modules: 1,
      bytes: 50,
    })
    await limited.get("example.org/a/@v/v1.0.0.mod")
    await expect(limited.get("example.org/b/@v/v1.0.0.mod")).rejects.toThrow()
    await expect(
      new GoMetadataBroker(Date.now() + 90000, undefined, fetch, { modules: 500, bytes: 1 }).get(
        "example.org/a/@v/v1.0.0.mod"
      )
    ).rejects.toThrow()
  })
  it("extracts missing metadata only from local proxy paths", () => {
    expect(
      missingGoMetadataPaths(
        "reading file:///proxy/example.org/!a/@v/v1.2.3.mod: no such file or directory\nreading https://evil.test/x: failed"
      )
    ).toEqual(["example.org/!a/@v/v1.2.3.mod"])
  })
  it("refuses blocked DNS, oversized responses and cancellation", async () => {
    const blocked = vi.fn(async () => ({ ok: false as const, reason: "ssrf_blocked" as const }))
    await expect(
      new GoMetadataBroker(Date.now() + 90000, undefined, blocked).get(
        "example.org/a/@v/v1.0.0.mod"
      )
    ).rejects.toThrow()
    const oversized = vi.fn(async () => ({
      ...ok("x"),
      result: { ...ok("x").result, bodyTruncated: true },
    }))
    await expect(
      new GoMetadataBroker(Date.now() + 90000, undefined, oversized).get(
        "example.org/a/@v/v1.0.0.mod"
      )
    ).rejects.toThrow()
    const controller = new AbortController()
    controller.abort()
    const fetch = vi.fn(async () => ok("x"))
    await expect(
      new GoMetadataBroker(Date.now() + 90000, controller.signal, fetch).get(
        "example.org/a/@v/v1.0.0.mod"
      )
    ).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
