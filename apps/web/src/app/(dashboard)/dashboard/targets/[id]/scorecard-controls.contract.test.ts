import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// apps/web has no component test harness; preserve the inline confirmation contract here.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const source = readFileSync(new URL("./scorecard-controls.tsx", import.meta.url), "utf8")

describe("scorecard confirmation", () => {
  it("uses honest inline semantics and restores focus to its trigger", () => {
    expect(source).toContain('role="group"')
    expect(source).not.toContain('aria-modal="true"')
    expect(source).not.toContain('role="alertdialog"')
    expect(source).toContain("requestAnimationFrame(() => confirmationTriggerRef.current?.focus())")
    expect(source).toContain("onClick={closeConfirmation}")
    expect(source).toContain("ref={noticeRef}")
    expect(source).toContain('role="status" tabIndex={-1}')
  })
})
