import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn() },
}))

import { clearThreatIntelligenceCache, fetchThreatSignals } from "./threat-intelligence"

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

    const signals = await fetchThreatSignals(
      ["CVE-2021-44228", "not-a-cve", "CVE-2021-44228"],
      fetchFn
    )

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
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("cisa.gov")) return new Response("unavailable", { status: 503 })
      return new Response(JSON.stringify({ data: [{ cve: "CVE-2024-12345", epss: "0.42" }] }))
    }) as unknown as typeof fetch

    await expect(fetchThreatSignals(["CVE-2024-12345"], fetchFn)).resolves.toEqual(
      new Map([["CVE-2024-12345", { epss: 0.42 }]])
    )
  })

  it("does not start enrichment when the parent scan is already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError")
      return new Response("{}")
    }) as unknown as typeof fetch

    await expect(
      fetchThreatSignals(["CVE-2024-12345"], fetchFn, controller.signal)
    ).rejects.toThrow("SCA scan cancelled")
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetchFn).mock.calls.every((call) => call[1]?.signal?.aborted)).toBe(true)
  })
})
