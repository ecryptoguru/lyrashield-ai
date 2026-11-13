import { describe, expect, it } from "vitest"
import { assessPhpRuntimeVersion, PHP_SESSION_UPLOAD_PROGRESS_NOTICE } from "./php-security"

describe("shared PHP runtime advisory assessment", () => {
  it.each([
    ["8.2.34", "8.2.35"],
    ["8.3.35", "8.3.36"],
    ["8.4.26", "8.4.27"],
    ["8.5.11", "8.5.12"],
  ])("assesses %s against the original advisory fixes", (version, fixedVersion) => {
    expect(assessPhpRuntimeVersion(version)).toMatchObject({
      status: "affected",
      version,
      fixedVersion,
      advisoryIds: ["CVE-2026-109618", "CVE-2026-109619"],
    })
    expect(assessPhpRuntimeVersion(fixedVersion)).toMatchObject({
      status: "fixed",
      advisoryIds: [],
    })
  })
  it.each(["8.4", "8.4.27RC1", "php:8.4.26-fpm", " 8.4.26", "8.4.26\n", "^8.4.26"])(
    "rejects inexact or decorated input %j",
    (version) => {
      expect(assessPhpRuntimeVersion(version).status).toBe("invalid")
    }
  )
  it.each(["7.4.33", "8.1.34", "8.6.0", "8.10.1"])("withholds a fix claim for %s", (version) => {
    expect(assessPhpRuntimeVersion(version)).toMatchObject({
      status: "unsupported",
      fixedVersion: null,
    })
  })
  it("keeps the October 23 notice separate from version-bounded fixes", () => {
    expect(PHP_SESSION_UPLOAD_PROGRESS_NOTICE).toMatchObject({ id: "CVE-2026-115560" })
    expect(PHP_SESSION_UPLOAD_PROGRESS_NOTICE).not.toHaveProperty("fixedVersion")
    expect(PHP_SESSION_UPLOAD_PROGRESS_NOTICE).not.toHaveProperty("ranges")
  })
})
