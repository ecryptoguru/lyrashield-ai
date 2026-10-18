import { describe, expect, it } from "vitest"
import { TOOL_EXAMPLES } from "./tool-examples"
import { checkHeaders, checkRlsSql, checkSetCookie, inspectJwt, reviewRlsSql } from "./tool-checks"

describe("local tool examples and SQL intent", () => {
  it("provides useful synthetic input without implying application-wide security", () => {
    expect(checkHeaders(TOOL_EXAMPLES.headers)).toEqual([
      "No common header omission found. Review values and route-specific behavior too.",
    ])
    expect(checkRlsSql(TOOL_EXAMPLES.sql)).toEqual([
      "No simple risky pattern found. Confirm behavior with a real two-account test.",
    ])
    expect(() => inspectJwt(TOOL_EXAMPLES.jwt)).not.toThrow()
    expect(TOOL_EXAMPLES.jwt).toContain("synthetic-signature")
    expect(checkSetCookie(TOOL_EXAMPLES.cookie).some((item) => /missing/i.test(item))).toBe(false)
  })

  it("labels missing policy context for review and permissive policies for attention", () => {
    const items = reviewRlsSql("create policy public_read on public.projects using (true);")
    expect(items).toContainEqual({
      intent: "attention",
      message: "A policy appears to allow every row with USING (true) or WITH CHECK (true).",
    })
    expect(
      items
        .filter((item) => item.message.startsWith("No "))
        .every((item) => item.intent === "review")
    ).toBe(true)
    expect(reviewRlsSql(TOOL_EXAMPLES.sql)[0].intent).toBe("info")
  })
})
