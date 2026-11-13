import { describe, expect, it } from "vitest"
import { assessPhp2Shell, assessSessionNotice } from "./php2shell-checker"

describe("PHP2Shell guided assessment", () => {
  it.each([
    ["8.2.34", "affected"],
    ["8.2.35", "fixed"],
    ["8.3.35", "affected"],
    ["8.3.36", "fixed"],
    ["8.4.26", "affected"],
    ["8.4.27", "fixed"],
    ["8.5.11", "affected"],
    ["8.5.12", "fixed"],
  ])("assesses %s within its branch", (version, status) => {
    expect(
      assessPhp2Shell({ version, source: "web", deployment: "container", backport: false }).runtime
        .status
    ).toBe(status)
  })
  it.each(["", "8.4", "^8.4.27", "8.4.27-vendor1", "8.6.0RC4", "<script>"])(
    "keeps invalid input %s unresolved",
    (version) => {
      expect(
        assessPhp2Shell({ version, source: "unknown", deployment: "unknown", backport: false })
          .runtime.status
      ).toBe("invalid")
    }
  )
  it("never treats a backport claim or CLI result as deployed verification", () => {
    const result = assessPhp2Shell({
      version: "8.4.26",
      source: "cli",
      deployment: "vendor",
      backport: true,
    })
    expect(result.runtime.status).toBe("affected")
    expect(result.notes.join(" ")).toMatch(/CLI/)
    expect(result.notes.join(" ")).toMatch(/vendor.*evidence/i)
    expect(result.verified).toBe(false)
  })
  it("keeps the follow-up review separate on patched PHP", () => {
    const result = assessPhp2Shell({
      version: "8.4.27",
      source: "web",
      deployment: "managed",
      backport: false,
    })
    expect(result.runtime.status).toBe("fixed")
    expect(result.session.status).toBe("unknown")
    expect(result.verified).toBe(false)
  })
})

describe("CVE-2026-115560 prerequisites", () => {
  it("requires all reported prerequisites for an identified combination", () => {
    expect(assessSessionNotice("yes", "php_binary", "yes").status).toBe("review")
    expect(assessSessionNotice("yes", "php_serialize", "yes").status).toBe("review")
  })
  it.each([
    ["no", "unknown", "unknown"],
    ["yes", "php", "yes"],
    ["yes", "php_binary", "no"],
  ] as const)("identifies a reported absent prerequisite", (upload, serializer, switchHandler) => {
    expect(assessSessionNotice(upload, serializer, switchHandler).status).toBe("not-indicated")
  })
  it("retains uncertainty if a prerequisite is unknown", () => {
    expect(assessSessionNotice("yes", "unknown", "yes").status).toBe("unknown")
  })
})
