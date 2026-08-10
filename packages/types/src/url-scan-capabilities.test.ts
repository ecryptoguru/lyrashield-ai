import { describe, expect, it } from "vitest"
import {
  URL_SCAN_CONTRACT_VERSION,
  getUrlModeAvailability,
  getUrlScanProfile,
} from "./url-scan-capabilities"

describe("URL scan capabilities", () => {
  it("defines the contract version", () => {
    expect(URL_SCAN_CONTRACT_VERSION).toBe("url-scan/2.0.0")
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

  it("requires an OpenAPI URL for API Standard and Deep", () => {
    expect(getUrlModeAvailability("API", "SAFE", false)).toEqual({ available: true })
    expect(getUrlModeAvailability("WEB_APP", "STANDARD", false)).toEqual({ available: true })
    expect(getUrlModeAvailability("API", "STANDARD", false)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Contract Review is not available yet.",
    })
    expect(getUrlModeAvailability("API", "STANDARD", true)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Contract Review is not available yet.",
    })
    expect(getUrlModeAvailability("WEB_APP", "DEEP", false)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Behavioral Surface Review is not available yet.",
    })
    expect(getUrlModeAvailability("API", "DEEP", false)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Contract Behavior Review is not available yet.",
    })
  })

  it("maps legacy Quick to Safe and rejects Custom", () => {
    expect(getUrlScanProfile("WEB_APP", "QUICK").id).toBe("WEB_APP_SAFE")
    expect(getUrlScanProfile("API", "QUICK").id).toBe("API_SAFE")
    expect(() => getUrlScanProfile("WEB_APP", "CUSTOM")).toThrow("URL_MODE_UNSUPPORTED")
    expect(() => getUrlScanProfile("API", "CUSTOM")).toThrow("URL_MODE_UNSUPPORTED")
  })

  it("rejects unsupported and custom modes through availability", () => {
    expect(getUrlModeAvailability("WEB_APP", "CUSTOM", false)).toMatchObject({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
    })
    expect(getUrlModeAvailability("API", "CUSTOM", false)).toMatchObject({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
    })
    expect(getUrlModeAvailability("WEB_APP", "UNKNOWN", false)).toMatchObject({
      available: false,
      code: "URL_MODE_UNSUPPORTED",
    })
  })
})
