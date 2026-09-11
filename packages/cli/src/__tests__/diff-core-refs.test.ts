import { describe, expect, it } from "vitest"
import { resolveDiffRange } from "../diff-core.js"

/**
 * VULN-E-001: --base/--head used to land in `git diff` argv verbatim, so an
 * option-shaped ref ("--output=$HOME/.lyrashield/credentials.json") was parsed
 * as a git option. Refs now resolve through `git rev-parse --verify
 * --end-of-options` to a 40-char SHA before any diff/show argv is built.
 *
 * The option-shaped cases reject before git is even invoked, so these tests
 * do not depend on running inside a checkout.
 */
describe("resolveDiffRange — git option injection guard", () => {
  it.each([
    ["--output=/tmp/evil"],
    ["--output", "/tmp/evil"],
    ["-o/tmp/evil"],
    ["--ext-diff"],
    ["--"],
  ])("rejects option-shaped ref %s", async (ref) => {
    await expect(resolveDiffRange(false, ref, "HEAD")).rejects.toThrow(/git ref/i)
    await expect(resolveDiffRange(false, "HEAD", ref)).rejects.toThrow(/git ref/i)
  })

  it("rejects a ref that rev-parse cannot resolve to a commit", async () => {
    // Not option-shaped, but not a real revision either — resolution must
    // fail rather than let the raw value through to git diff/show argv.
    await expect(
      resolveDiffRange(false, "definitely-not-a-real-ref-xyz", "HEAD")
    ).rejects.toThrow(/Cannot resolve git ref/)
  })
})
