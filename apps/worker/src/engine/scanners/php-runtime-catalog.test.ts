import { describe, expect, it } from "vitest"
import { PHP_RUNTIME_CATALOG, PHP_RUNTIME_CATALOG_SCHEMA } from "./php-runtime-catalog"
import { inspectPhpRuntimeInput } from "./php-runtime"

describe("pinned PHP advisory catalog", () => {
  it("retains the complete 29 advisory publication inventory, including GHSA without CVE", () => {
    const published = PHP_RUNTIME_CATALOG.advisories.filter((a) => a.published.startsWith("2026"))
    expect(published.map((a) => a.id).sort()).toEqual(
      [
        "CVE-2026-93682",
        "CVE-2026-109618",
        "CVE-2026-109619",
        "CVE-2026-91768",
        "GHSA-ch8v-r6jh-4vvr",
        "CVE-2026-14355",
        "CVE-2026-91766",
        "CVE-2026-91765",
        "CVE-2026-17543",
        "CVE-2026-17544",
        "CVE-2026-12184",
        "CVE-2026-91767",
        "CVE-2026-7262",
        "CVE-2026-7261",
        "CVE-2026-6722",
        "CVE-2026-7258",
        "CVE-2026-17545",
        "CVE-2026-7260",
        "CVE-2026-91769",
        "CVE-2026-6103",
        "CVE-2026-6104",
        "CVE-2026-7263",
        "CVE-2026-92842",
        "CVE-2026-6735",
        "CVE-2026-7568",
        "CVE-2026-7259",
        "CVE-2025-14179",
        "CVE-2025-14181",
        "CVE-2025-1218",
      ].sort()
    )
    expect(
      published.every((a) =>
        a.url.startsWith("https://github.com/php/php-src/security/advisories/")
      )
    ).toBe(true)
  })
  it.each(["8.2.34", "8.3.35", "8.4.26", "8.5.11"])(
    "matches both PHP2Shell advisories for %s",
    (version) => {
      const { findings } = inspectPhpRuntimeInput(
        "Dockerfile",
        `FROM php:${version}-apache\n`,
        "dockerfile"
      )
      expect(
        findings
          .filter((f) => ["CVE-2026-109618", "CVE-2026-109619"].includes(f.cve ?? ""))
          .map((f) => f.cve)
          .sort()
      ).toEqual(["CVE-2026-109618", "CVE-2026-109619"])
    }
  )
  it.each(["8.2.35", "8.3.36", "8.4.27", "8.5.12"])(
    "does not flag the patched PHP2Shell branch %s",
    (version) => {
      expect(
        inspectPhpRuntimeInput("Dockerfile", `FROM php:${version}-apache\n`, "dockerfile").findings
      ).toEqual([])
    }
  )
  it.each([
    { branch: "8.4", introduced: "8.3.0", fixed: "8.4.27", sourceRange: "< 8.4.27" },
    { branch: "8.4", introduced: "8.4.0", fixed: "8.4.27", sourceRange: "8.4.*" },
    { branch: "8.4", introduced: "8.4.0", fixed: "8.4.27", sourceRange: "< 8.3.27" },
  ])("rejects ambiguous range data %j", (range) => {
    const catalog = structuredClone(PHP_RUNTIME_CATALOG)
    catalog.advisories[0]!.ranges = [range]
    expect(PHP_RUNTIME_CATALOG_SCHEMA.safeParse(catalog).success).toBe(false)
  })
  it("rejects duplicate branch ranges", () => {
    const catalog = structuredClone(PHP_RUNTIME_CATALOG)
    catalog.advisories[0]!.ranges.push({ ...catalog.advisories[0]!.ranges[0]! })
    expect(PHP_RUNTIME_CATALOG_SCHEMA.safeParse(catalog).success).toBe(false)
  })
})
