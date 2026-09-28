import { afterEach, describe, expect, it, vi } from "vitest"

const error = vi.fn()
const sentry = vi.hoisted(() => ({ init: vi.fn(), captureRequestError: vi.fn() }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error, warn: vi.fn() } }))
vi.mock("@sentry/nextjs", () => sentry)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("request instrumentation", () => {
  it("records unhandled request errors", async () => {
    vi.stubEnv("SENTRY_DSN", "")
    const { onRequestError } = await import("./instrumentation")
    await onRequestError(
      new Error("boom"),
      { path: "/api/test", method: "GET", headers: {} },
      {
        routerKind: "App Router",
        routePath: "/api/test",
        routeType: "route",
        renderSource: "react-server-components",
        revalidateReason: undefined,
      }
    )
    expect(error).toHaveBeenCalledWith(
      "Unhandled web request error",
      expect.objectContaining({ path: "/api/test", error: "boom" })
    )
  })

  it("initializes server and edge runtimes but never treats server registration as browser setup", async () => {
    const { register } = await import("./instrumentation")
    vi.stubEnv("SENTRY_DSN", "https://server@example.ingest.sentry.io/1")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://browser@example.ingest.sentry.io/2")

    vi.stubEnv("NEXT_RUNTIME", "nodejs")
    await register()
    expect(sentry.init).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dsn: "https://server@example.ingest.sentry.io/1",
        tracesSampleRate: 0.1,
      })
    )

    vi.stubEnv("NEXT_RUNTIME", "edge")
    await register()
    expect(sentry.init).toHaveBeenCalledTimes(2)

    sentry.init.mockClear()
    vi.stubEnv("NEXT_RUNTIME", "")
    await register()
    expect(sentry.init).not.toHaveBeenCalled()
  })
})
