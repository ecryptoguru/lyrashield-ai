import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Target soft-delete UX contract (Deep Review v17 1.3): the inline confirm
 * names the target and states what is retained, and the detail page places a
 * danger section below Domain verification.
 */
describe("target delete confirmation copy", () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const card = readFileSync(new URL("./delete-target-card.tsx", import.meta.url), "utf8")
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const table = readFileSync(new URL("../targets-client.tsx", import.meta.url), "utf8")

  it("names the target and states what is retained", () => {
    expect(card).toContain("Delete {targetName}")
    expect(card).toContain("Delete ${targetName}?")
    expect(card).toContain("Scans, findings, verdicts and reports stay in the workspace")
    expect(card).toContain("target slots")
  })

  it("routes through the existing inline confirm, not a native dialog", () => {
    expect(card).toContain("InlineConfirm")
    expect(card).not.toContain("window.confirm")
    expect(card).not.toContain("confirm(")
  })

  it("renders the danger section below Domain verification on the detail page", () => {
    const domainIdx = page.indexOf("<DomainVerificationCard")
    const deleteIdx = page.indexOf("<DeleteTargetCard")
    expect(domainIdx).toBeGreaterThan(-1)
    expect(deleteIdx).toBeGreaterThan(domainIdx)
  })

  it("offers the same retained-history wording in the targets table", () => {
    expect(table).toContain("Scans, findings, verdicts and reports stay in the workspace")
    expect(table).toContain("InlineConfirm")
  })
})
