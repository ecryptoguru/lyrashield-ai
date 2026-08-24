import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn() },
}))

import { clearThreatIntelligenceCache, fetchThreatSignals } from "./threat-intelligence"

const publicResolver = async () => ["93.184.216.34"]

describe("fetchThreatSignals", () => {
  beforeEach(() => clearThreatIntelligenceCache())

  it("combines CISA KEV and FIRST EPSS data for bounded CVE-only requests", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("cisa.gov")) {
        return new Response(
          JSON.stringify({
            vulnerabilities: [
              {
                cveID: "CVE-2021-44228",
                dateAdded: "2021-12-10",
                dueDate: "2021-12-24",
                knownRansomwareCampaignUse: "Known",
              },
            ],
          })
        )
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              cve: "CVE-2021-44228",
              epss: "0.99999",
              percentile: "1.0",
              date: "2026-07-17",
            },
          ],
        })
      )
    }) as unknown as typeof fetch

    const signals = await fetchThreatSignals(["CVE-2021-44228", "not-a-cve", "CVE-2021-44228"], {
      fetchFn,
    })

    expect(signals.get("CVE-2021-44228")).toEqual({
      knownExploited: true,
      dateAdded: "2021-12-10",
      dueDate: "2021-12-24",
      knownRansomwareCampaignUse: "Known",
      epss: 0.99999,
      percentile: 1,
      epssDate: "2026-07-17",
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(String(vi.mocked(fetchFn).mock.calls[1]?.[0])).toContain("CVE-2021-44228")
    expect(String(vi.mocked(fetchFn).mock.calls[1]?.[0])).not.toContain("not-a-cve")
  })

  it("returns partial intelligence when one public source is unavailable", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ cve: "CVE-2024-12345", epss: "0.42" }] }))
    }) as unknown as typeof fetch
    const cisaFetchFn = vi.fn(
      async () => new Response("unavailable", { status: 503 })
    ) as unknown as typeof fetch

    await expect(
      fetchThreatSignals(["CVE-2024-12345"], {
        fetchFn,
        cisaFetchFn,
        cisaResolver: publicResolver,
      })
    ).resolves.toEqual(new Map([["CVE-2024-12345", { epss: 0.42 }]]))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetchFn).mock.calls[0]?.[0])).toContain("api.first.org")
    expect(cisaFetchFn).toHaveBeenCalledTimes(1)
  })

  it("routes only CISA through the safe custom fetch and follows redirects", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ cve: "CVE-2024-12345", epss: "0.25" }] }))
    ) as unknown as typeof fetch
    const cisaFetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: "/feeds/known_exploited_vulnerabilities.json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ vulnerabilities: [{ cveID: "CVE-2024-12345" }] }), {
          headers: { "Content-Type": "application/json" },
        })
      ) as unknown as typeof fetch

    await expect(
      fetchThreatSignals(["CVE-2024-12345"], {
        fetchFn,
        cisaFetchFn,
        cisaResolver: publicResolver,
      })
    ).resolves.toEqual(new Map([["CVE-2024-12345", { knownExploited: true, epss: 0.25 }]]))

    expect(cisaFetchFn).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(cisaFetchFn).mock.calls.every((call) => String(call[0]).includes("cisa.gov"))
    ).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetchFn).mock.calls[0]?.[0])).toContain("api.first.org/data/v1/epss?")
  })

  it("rejects an oversized proxied CISA response while retaining FIRST data", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ cve: "CVE-2024-12345", epss: "0.1" }] }))
    ) as unknown as typeof fetch
    const cisaFetchFn = vi.fn(
      async () => new Response("x".repeat(5 * 1024 * 1024 + 1))
    ) as unknown as typeof fetch

    await expect(
      fetchThreatSignals(["CVE-2024-12345"], {
        fetchFn,
        cisaFetchFn,
        cisaResolver: publicResolver,
      })
    ).resolves.toEqual(new Map([["CVE-2024-12345", { epss: 0.1 }]]))
  })

  it("does not start enrichment when the parent scan is already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError")
      return new Response("{}")
    }) as unknown as typeof fetch
    const cisaFetchFn = vi.fn(async () => new Response("{}")) as unknown as typeof fetch

    await expect(
      fetchThreatSignals(["CVE-2024-12345"], {
        fetchFn,
        cisaFetchFn,
        cisaResolver: publicResolver,
        signal: controller.signal,
      })
    ).rejects.toThrow("SCA scan cancelled")
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchFn).mock.calls.every((call) => call[1]?.signal?.aborted)).toBe(true)
    expect(cisaFetchFn).not.toHaveBeenCalled()
  })
})
