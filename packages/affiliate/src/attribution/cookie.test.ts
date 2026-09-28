import { describe, expect, it } from "vitest"
import { AFFILIATE_COOKIE_NAME, buildAffiliateCookie, parseAffiliateCookie } from "./cookie"

describe("affiliate attribution cookie", () => {
  it("uses the exported cookie name when writing and parsing tokens", () => {
    const cookie = buildAffiliateCookie("opaque token", {
      domain: "example.test",
      secure: false,
    })

    expect(cookie).toContain(`${AFFILIATE_COOKIE_NAME}=opaque%20token`)
    expect(parseAffiliateCookie(`other=value; ${AFFILIATE_COOKIE_NAME}=opaque%20token`)).toBe(
      "opaque token"
    )
  })
})
