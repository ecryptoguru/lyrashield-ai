import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { transpileModule, ScriptTarget } from "typescript"
import { describe, expect, it, vi } from "vitest"

const page = readFileSync(new URL("../pages/scan.astro", import.meta.url), "utf8")
// Execute the actual inline handler, with all I/O replaced by local fixtures.
const handlerSource = page.slice(
  page.indexOf("async function handleCaptureFormSubmit"),
  page.indexOf("async function handleShareScorecard")
)
const compiled = transpileModule(handlerSource, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText

describe("scorecard fresh-proof recovery", () => {
  it.each(["lost-response", "server-error", "success"])(
    "retires the proof after %s",
    async (outcome) => {
      let widgetProof = "first-proof"
      const status = { textContent: "" }
      const posts: string[] = []
      const reset = vi.fn(() => {
        widgetProof = ""
      })
      const readiness = vi.fn()
      const sandbox = {
        URL,
        currentResult: { liteResultSummary: { needsAttention: 0, worthReviewing: 0, looksOk: 1 } },
        referralCode: undefined,
        attribution: {},
        referrer: "",
        lastAction: "scorecard",
        appOrigin: "https://api.test",
        turnstileWidget: "widget",
        turnstileToken: widgetProof,
        capture: vi.fn(),
        updateScanReadiness: readiness,
        window: { turnstile: { getResponse: () => widgetProof, reset } },
        document: {
          querySelector: (selector: string) =>
            selector === "#result-email"
              ? { value: "visitor@example.test" }
              : selector === "#capture-status"
                ? status
                : { href: "", classList: { add() {}, remove() {} } },
        },
        fetch: async (url: string, init: RequestInit) => {
          if (url === "/api/waitlist") return Response.json({})
          posts.push(JSON.parse(String(init.body)).turnstileToken)
          if (posts.length === 1 && outcome === "lost-response") throw new Error("Response lost")
          return outcome === "server-error" && posts.length === 1
            ? Response.json({}, { status: 503 })
            : Response.json({ url: "/lite-check/fixture" })
        },
      }
      const submit = runInNewContext(`${compiled}\nhandleCaptureFormSubmit`, sandbox) as (event: {
        preventDefault(): void
      }) => Promise<void>
      await submit({ preventDefault() {} })
      expect(widgetProof).toBe("")
      expect(sandbox.turnstileToken).toBe("")
      expect(readiness).toHaveBeenCalled()
      // Until the widget issues a fresh proof, another submit cannot mint.
      await submit({ preventDefault() {} })
      expect(posts).toEqual(["first-proof"])
      widgetProof = "fresh-proof"
      sandbox.turnstileToken = widgetProof
      await submit({ preventDefault() {} })
      expect(posts).toEqual(["first-proof", "fresh-proof"])
    }
  )
})
