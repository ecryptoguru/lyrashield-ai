import { describe, expect, it, vi } from "vitest"

const error = vi.fn()
vi.mock("@lyrashield/logger", () => ({ logger: { error } }))

describe("request instrumentation", () => {
  it("records unhandled request errors", async () => {
    const { onRequestError } = await import("./instrumentation")
    await onRequestError(
      new Error("boom"),
      { path: "/api/test", method: "GET", headers: {} },
      {
        routerKind: "App Router",
        routePath: "/api/test",
        routeType: "route",
        renderSource: "react-server-components",
      }
    )
    expect(error).toHaveBeenCalledWith(
      "Unhandled web request error",
      expect.objectContaining({ path: "/api/test", error: "boom" })
    )
  })
})
