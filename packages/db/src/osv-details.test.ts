import { describe, expect, it } from "vitest"
import { hydrateOsvDetails } from "./osv-details"
const signal = () => AbortSignal.timeout(5000)

describe("bounded OSV advisory details", () => {
  it("deduplicates IDs and limits concurrency to eight and detail requests to 200", async () => {
    const candidates = Array.from({ length: 201 }, (_, i) => ({ id: `GHSA-record-${i}` }))
    let active = 0,
      peak = 0,
      requests = 0
    const result = await hydrateOsvDetails(
      [...candidates, candidates[0]!],
      async (url, init) => {
        expect(init?.redirect).toBe("error")
        requests++
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        active--
        return new Response(JSON.stringify({ id: String(url).split("/").pop(), affected: [] }))
      },
      signal()
    )
    expect(requests).toBe(200)
    expect(peak).toBeLessThanOrEqual(8)
    expect(result.incomplete).toBe(true)
    expect(result.vulns).toHaveLength(202)
    expect(result.vulns[200]).toEqual(candidates[200])
  })
  it("does not send invalid IDs or requests after cancellation", async () => {
    let calls = 0
    const fetchFn = async () => {
      calls++
      return new Response("{}")
    }
    const invalid = await hydrateOsvDetails([{ id: "../other-host" }], fetchFn, signal())
    const stopped = await hydrateOsvDetails([{ id: "GHSA-record" }], fetchFn, AbortSignal.abort())
    expect(calls).toBe(0)
    expect(invalid.incomplete).toBe(true)
    expect(stopped.incomplete).toBe(true)
  })
  it("preserves a complete record and marks malformed entries incomplete", async () => {
    const result = await hydrateOsvDetails(
      [{ id: "GHSA-record", affected: [] }, null as never],
      async () => {
        throw new Error("unneeded")
      },
      signal()
    )
    expect(result).toEqual({ vulns: [{ id: "GHSA-record", affected: [] }], incomplete: true })
  })
})
