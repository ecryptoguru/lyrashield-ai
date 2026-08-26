import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// apps/web has no component test harness; preserve the bounded request contract here.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const evidenceSource = readFileSync(new URL("./ai-assurance-client.tsx", import.meta.url), "utf8")
// eslint-disable-next-line security/detect-non-literal-fs-filename
const inventorySource = readFileSync(new URL("./assurance-inventory.tsx", import.meta.url), "utf8")

describe("AI assurance mutation transport", () => {
  it("uses the shared bounded JSON client for evidence and inventory mutations", () => {
    expect(evidenceSource).toContain('import { apiPost } from "@/lib/api-client"')
    expect(evidenceSource.match(/apiPost</g)).toHaveLength(3)
    expect(inventorySource).toContain('import { apiPost } from "@/lib/api-client"')
    expect(inventorySource.match(/apiPost</g)).toHaveLength(2)
  })

  it("bounds raw artifact uploads and normalizes malformed responses", () => {
    expect(evidenceSource).toContain("signal: AbortSignal.timeout(30_000)")
    expect(evidenceSource).toContain("The artifact upload returned an invalid response")
    expect(evidenceSource).toContain("The artifact upload timed out")
  })
})
