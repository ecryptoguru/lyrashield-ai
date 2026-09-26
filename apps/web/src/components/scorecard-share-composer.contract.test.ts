import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import * as Composer from "./scorecard-share-composer"

const permissionState = vi.hoisted(() => ({ allowed: true }))

vi.mock("../lib/analytics", () => ({
  ANALYTICS_PREFERENCE_EVENT: "lyrashield:analytics-preference",
  analyticsPermissionAllowsOptionalCollection: () => permissionState.allowed,
  resolveAnalyticsPreference: vi.fn(async () => permissionState.allowed),
  track: vi.fn(),
}))

// The web package uses Node for component tests; assert the small interaction contracts here.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const source = readFileSync(new URL("./scorecard-share-composer.tsx", import.meta.url), "utf8")

describe("scorecard share composer contracts", () => {
  it("uses the selected image dimensions and keeps the preview uncropped", () => {
    expect(source).toContain("aspectRatio: `${dimensions.width} / ${dimensions.height}`")
    expect(source).toContain('className="object-contain"')
    expect(source).not.toContain("aspect-1200/630")
  })

  it("records no share handoff after native share cancellation", () => {
    expect(source).toContain(
      'if (cause instanceof DOMException && cause.name === "AbortError") return'
    )
    expect(source.indexOf("await navigator.share(shareData)")).toBeLessThan(
      source.indexOf('await recordEvent("native")')
    )
  })

  it("keeps sharing available while analytics permission is unresolved or off", () => {
    expect(source).toContain(
      "scorecardChannelUrlWithCurrentPermission(channel, absolute(url), caption)"
    )
    expect(source).not.toContain("optionalTrackingEnabled")
    expect(source).toContain("onClick={() => void nativeShare()}")
    expect(source).not.toContain("disabled={!optionalTrackingEnabled}")
  })

  it("does not describe channel opens as verified posts or impressions", () => {
    expect(source).toContain("Share actions do not verify external")
    expect(source).toContain("posts or impressions.")
  })

  it("reads analytics permission immediately before building each outgoing link", () => {
    const buildUrl = Reflect.get(Composer, "scorecardUrlWithCurrentPermission")
    const buildChannelUrl = Reflect.get(Composer, "scorecardChannelUrlWithCurrentPermission")
    expect(typeof buildUrl).toBe("function")
    expect(typeof buildChannelUrl).toBe("function")
    if (typeof buildUrl !== "function" || typeof buildChannelUrl !== "function") return

    const url = "https://app.test/score/ABC?ref=CODE"
    const build = buildUrl as (url: string, source: string) => string
    const buildChannel = buildChannelUrl as (
      channel: string,
      url: string,
      caption: string
    ) => string

    permissionState.allowed = true
    expect(new URL(build(url, "copy")).searchParams.get("ref")).toBe("CODE")
    expect(decodeURIComponent(buildChannel("linkedin", url, "Scoped review"))).toContain(
      "source=linkedin"
    )

    // Model a privacy preference changing after render but immediately before the user action.
    permissionState.allowed = false
    for (const source of ["native", "copy", "embed"]) {
      const outgoing = new URL(build(url, source))
      expect(outgoing.search).toBe("")
    }
    const channelUrl = buildChannel("linkedin", url, "Scoped review")
    expect(channelUrl).toContain("https://www.linkedin.com/sharing/share-offsite/")
    expect(decodeURIComponent(channelUrl)).not.toMatch(/ref=|source=|utm_/)

    expect(source).not.toContain("optionalTrackingEnabled")
    expect(source).toContain("analyticsPermissionAllowsOptionalCollection()")
    expect(source).toContain('scorecardUrlWithCurrentPermission(absolute(url), "native")')
    expect(source).toContain('scorecardUrlWithCurrentPermission(absolute(url), "copy")')
    expect(source).toContain('scorecardUrlWithCurrentPermission(absolute(url), "embed")')
    expect(source).toContain(
      "scorecardChannelUrlWithCurrentPermission(channel, absolute(url), caption)"
    )
  })
})
