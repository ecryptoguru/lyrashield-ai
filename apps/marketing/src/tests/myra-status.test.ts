/**
 * Public Myra status probe (v19 fix 1.1): the marketing site renders only
 * what /api/myra/status reports. The launcher stays hidden while
 * public:false, the /demo slot picker stays hidden while booking:false, and
 * any probe failure resolves to both false so a degraded app can never leave
 * a dead Myra affordance on the page.
 */
import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchMyraStatus } from "../components/myra/myra-session"

const read = (path: string) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(new URL(path, import.meta.url), "utf8")

const API = "https://app.example.com"

function stubStatus(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body, { status }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("fetchMyraStatus", () => {
  it("resolves the reported capabilities verbatim", async () => {
    stubStatus({ public: true, booking: true })
    await expect(fetchMyraStatus(API)).resolves.toEqual({ public: true, booking: true })

    stubStatus({ public: true, booking: false })
    await expect(fetchMyraStatus(API)).resolves.toEqual({ public: true, booking: false })

    stubStatus({ public: false, booking: false })
    await expect(fetchMyraStatus(API)).resolves.toEqual({ public: false, booking: false })
  })

  it("treats missing fields as false", async () => {
    stubStatus({})
    await expect(fetchMyraStatus(API)).resolves.toEqual({ public: false, booking: false })
    stubStatus({ public: "yes", booking: 1 })
    await expect(fetchMyraStatus(API)).resolves.toEqual({ public: false, booking: false })
  })

  it("resolves both false on a non-2xx response", async () => {
    stubStatus({ public: true, booking: true }, 404)
    await expect(fetchMyraStatus(API)).resolves.toEqual({ public: false, booking: false })
    stubStatus({ public: true, booking: true }, 500)
    await expect(fetchMyraStatus(API)).resolves.toEqual({ public: false, booking: false })
  })

  it("resolves both false on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      })
    )
    await expect(fetchMyraStatus(API)).resolves.toEqual({ public: false, booking: false })
  })

  it("resolves both false when the probe times out", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            )
          })
      )
    )
    const pending = fetchMyraStatus(API)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(pending).resolves.toEqual({ public: false, booking: false })
  })
})

describe("marketing surfaces honor the status probe", () => {
  it("keeps the launcher hidden until status reports public:true", () => {
    const panel = read("../components/myra/MyraPanel.astro")
    // The button ships hidden — the script reveals it only on public:true.
    const launcher = panel.slice(
      panel.indexOf('id="myra-launcher"'),
      panel.indexOf("Help")
    )
    expect(launcher).toContain("hidden")
    expect(panel).toContain("fetchMyraStatus")
    expect(panel).toContain("status.public")
  })

  it("keeps the /demo slot picker hidden until status reports booking:true", () => {
    const demo = read("../pages/demo.astro")
    expect(demo).toContain('id="demo-step-slot" hidden')
    expect(demo).toContain('id="demo-booking-closed"')
    expect(demo).toContain("Demo booking opens soon. Request a time and we follow up by email.")
    // Booking work is gated: the closed fallback must reach the DOM before
    // the picker, and the booking check must precede the first slot fetch.
    const closedIndex = demo.indexOf('id="demo-booking-closed"')
    const slotIndex = demo.indexOf('id="demo-step-slot"')
    const statusIndex = demo.indexOf("status.booking")
    const fetchSlotsIndex = demo.lastIndexOf("void fetchSlots()")
    expect(closedIndex).toBeGreaterThan(-1)
    expect(closedIndex).toBeLessThan(slotIndex)
    expect(statusIndex).toBeGreaterThan(-1)
    expect(statusIndex).toBeLessThan(fetchSlotsIndex)
  })
})
