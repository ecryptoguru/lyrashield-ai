import { describe, expect, it } from "vitest"
import { validatePlatformAdminActionRequest } from "./platform-admin-request"

function request(headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/admin/elevations", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      origin: "https://app.lyrashieldai.com",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: "{}",
  })
}

describe("platform admin action request boundary", () => {
  it("accepts same-origin JSON and a high-entropy elevation nonce", () => {
    expect(
      validatePlatformAdminActionRequest(
        request({ "x-lyrashield-admin-elevation": "A".repeat(43) }),
        { requireElevationNonce: true, allowedOrigin: "https://app.lyrashieldai.com" }
      )
    ).toEqual({ ok: true, elevationNonce: "A".repeat(43) })
  })

  it.each([
    ["cross-origin fetch", { "sec-fetch-site": "cross-site" }, "SAME_ORIGIN_REQUIRED"],
    ["missing fetch metadata", { "sec-fetch-site": "" }, "SAME_ORIGIN_REQUIRED"],
    ["sibling subdomain", { origin: "https://admin.lyrashieldai.com" }, "ORIGIN_FORBIDDEN"],
    ["foreign origin", { origin: "https://evil.example" }, "ORIGIN_FORBIDDEN"],
    ["form body", { "content-type": "application/x-www-form-urlencoded" }, "JSON_REQUIRED"],
    ["missing nonce", { "x-lyrashield-admin-elevation": "" }, "ADMIN_ELEVATION_REQUIRED"],
    ["invalid nonce", { "x-lyrashield-admin-elevation": "short" }, "ADMIN_ELEVATION_REQUIRED"],
  ])("rejects %s", (_name, headers, code) => {
    expect(
      validatePlatformAdminActionRequest(request(headers), {
        requireElevationNonce: true,
        allowedOrigin: "https://app.lyrashieldai.com",
      })
    ).toMatchObject({ ok: false, code })
  })
})
