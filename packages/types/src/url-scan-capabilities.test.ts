import { describe, expect, it } from "vitest"
import {
  URL_SCAN_CONTRACT_VERSION,
  getUrlModeAvailability,
  getUrlScanProfile,
  resolveTargetScanMode,
} from "./url-scan-capabilities"

describe("URL scan capabilities", () => {
  it("defines the contract version", () => {
    expect(URL_SCAN_CONTRACT_VERSION).toBe("url-scan/3.0.0")
  })

  it("defines reproducible web limits", () => {
    expect(getUrlScanProfile("WEB_APP", "SAFE")).toMatchObject({
      id: "WEB_APP_SAFE",
      maxDocuments: 1,
      maxAssets: 6,
      maxDepth: 0,
      maxTotalBytes: 8 * 1024 * 1024,
      allowedMethods: ["GET"],
    })
    expect(getUrlScanProfile("WEB_APP", "STANDARD")).toMatchObject({
      id: "WEB_APP_STANDARD",
      maxDocuments: 20,
      maxAssets: 30,
      maxDepth: 2,
      maxTotalBytes: 25 * 1024 * 1024,
    })
    expect(getUrlScanProfile("WEB_APP", "DEEP")).toMatchObject({
      id: "WEB_APP_DEEP",
      maxDocuments: 40,
      maxAssets: 50,
      maxMethodProbes: 20,
      maxOriginProbes: 10,
      allowedMethods: ["GET", "HEAD", "OPTIONS"],
    })
  })

  it.each([
    ["WEB_APP", "SAFE"],
    ["WEB_APP", "STANDARD"],
    ["WEB_APP", "DEEP"],
    ["API", "SAFE"],
    ["API", "STANDARD"],
    ["API", "DEEP"],
  ] as const)("returns an exact profile for %s/%s", (targetType, mode) => {
    const profile = getUrlScanProfile(targetType, mode)
    expect(profile).toEqual({
      ...profile,
      id: `${targetType}_${mode}`,
      targetType,
      mode,
    })
    expect(profile.allowedMethods.every((m) => ["GET", "HEAD", "OPTIONS"].includes(m))).toBe(true)
  })

  it("gates URL modes by release state and OpenAPI requirement", () => {
    expect(getUrlModeAvailability("API", "SAFE", false)).toEqual({ available: true })
    expect(getUrlModeAvailability("WEB_APP", "QUICK", false)).toEqual({ available: true })
    // The launch offering admits only the deterministic tier.
    expect(getUrlModeAvailability("WEB_APP", "STANDARD", false)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Engine Review is not available yet.",
    })
    expect(getUrlModeAvailability("WEB_APP", "DEEP", false)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Deep Live Review is not available yet.",
    })
    expect(getUrlModeAvailability("API", "STANDARD", true)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Engine Contract Review is not available yet.",
    })
    expect(getUrlModeAvailability("API", "DEEP", true)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Deep Contract Review is not available yet.",
    })
    expect(getUrlModeAvailability("API", "STANDARD", false)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Engine Contract Review is not available yet.",
    })
  })

  it("resolves target/mode combinations and returns a typed result", () => {
    expect(
      resolveTargetScanMode({ targetType: "REPO", mode: "STANDARD", hasApiSpec: false })
    ).toEqual({
      ok: true,
      profile: null,
    })

    expect(
      resolveTargetScanMode({ targetType: "API", mode: "STANDARD", hasApiSpec: false })
    ).toEqual({
      ok: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Engine Contract Review is not available yet.",
    })

    // The launch offering admits only the deterministic tier, so an unsupported
    // tier is refused before an API specification is considered.
    const apiStandard = resolveTargetScanMode({
      targetType: "API",
      mode: "STANDARD",
      hasApiSpec: true,
    })
    expect(apiStandard.ok).toBe(false)

    const webStandard = resolveTargetScanMode({
      targetType: "WEB_APP",
      mode: "STANDARD",
      hasApiSpec: false,
    })
    expect(webStandard.ok).toBe(false)

    expect(
      resolveTargetScanMode({ targetType: "WEB_APP", mode: "FAKE", hasApiSpec: false })
    ).toEqual({
      ok: false,
      code: "URL_MODE_UNSUPPORTED",
      reason: "Mode 'FAKE' is not supported for URL or API targets",
    })
  })

  it("maps legacy Quick to Safe and Custom to Deep", () => {
    expect(getUrlScanProfile("WEB_APP", "QUICK").id).toBe("WEB_APP_SAFE")
    expect(getUrlScanProfile("API", "QUICK").id).toBe("API_SAFE")
    expect(getUrlScanProfile("WEB_APP", "CUSTOM").id).toBe("WEB_APP_DEEP")
    expect(getUrlScanProfile("API", "CUSTOM").id).toBe("API_DEEP")
  })

  it("defaults an omitted profile to Quick", () => {
    expect(resolveTargetScanMode({ targetType: "WEB_APP", mode: "", hasApiSpec: false })).toEqual({
      ok: true,
      profile: expect.objectContaining({ id: "WEB_APP_SAFE", mode: "SAFE" }),
    })
    expect(resolveTargetScanMode({ targetType: "API", mode: "   ", hasApiSpec: false })).toEqual({
      ok: true,
      profile: expect.objectContaining({ id: "API_SAFE", mode: "SAFE" }),
    })
  })

  it("rejects only truly unsupported modes through availability", () => {
    // CUSTOM maps onto Deep, which is outside the launch offering.
    expect(getUrlModeAvailability("WEB_APP", "CUSTOM", false)).toMatchObject({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
    })
    expect(getUrlModeAvailability("API", "CUSTOM", false)).toMatchObject({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
    })
    expect(getUrlModeAvailability("API", "CUSTOM", true)).toMatchObject({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
    })
    expect(getUrlModeAvailability("WEB_APP", "UNKNOWN", false)).toMatchObject({
      available: false,
      code: "URL_MODE_UNSUPPORTED",
    })
  })
})
