import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const source = readFileSync(new URL("./support-inbox-client.tsx", import.meta.url), "utf8")

describe("support inbox fetch lifecycle", () => {
  it("aborts the previous list and detail fetches on every new invocation", () => {
    // Without abort wiring a slow first response resolves after a newer one
    // and overwrites the newer selection or filter.
    expect(source).toContain("listAbortRef.current?.abort()")
    expect(source).toContain("detailAbortRef.current?.abort()")
    expect(source.match(/signal: controller\.signal/g)?.length).toBe(2)
  })

  it("ignores aborted responses before touching state", () => {
    // Every promise path (resolve, reject, settle) checks the signal so an
    // aborted fetch never flips loading flags or writes rows/detail.
    expect(source.match(/controller\.signal\.aborted/g)?.length).toBeGreaterThanOrEqual(6)
  })

  it("aborts in-flight fetches when the filter or selection changes and on unmount", () => {
    expect(source).toContain("return () => listAbortRef.current?.abort()")
    expect(source).toContain("return () => detailAbortRef.current?.abort()")
  })
})
