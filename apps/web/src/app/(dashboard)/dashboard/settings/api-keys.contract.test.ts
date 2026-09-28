import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"

/**
 * Least-privilege contract for the API-key create form.
 *
 * Regression guard: the form previously cleared only the name after a
 * successful create, leaving the scope radio on its previous value. Creating a
 * read-only key right after a read-write one therefore silently granted write
 * access to a key the user believed was read-only. The reset must always
 * include the scope, and every path that closes the form must use it.
 *
 * (apps/web has no React component-test harness; this asserts the source
 * contract, matching the existing source-contract test precedent in the repo.)
 */
describe("API keys create-form scope reset", () => {
  const source = readFileSync(new URL("./api-keys.tsx", import.meta.url), "utf8")

  it("resets name AND scope to the least-privilege default when closing the form", () => {
    const fn = source.match(/function closeCreateForm\(\)\s*\{[\s\S]*?\n\s{2}\}/)?.[0]
    expect(fn, "closeCreateForm() must exist").toBeTruthy()
    expect(fn).toContain('setScope("read")')
    expect(fn).toContain('setName("")')
    expect(fn).toContain("setShowCreate(false)")
  })

  it("uses the shared reset on the success, cancel, and toggle paths", () => {
    // Success path inside handleCreate.
    const handleCreate = source.match(/async function handleCreate\(\)[\s\S]*?\n\s{2}\}/)?.[0]
    expect(handleCreate).toContain("closeCreateForm()")
    // Cancel button and the header toggle must not bypass the reset by calling
    // setShowCreate(false) directly.
    const directCloses = source.match(/setShowCreate\(false\)/g) ?? []
    expect(
      directCloses.length,
      "setShowCreate(false) should only appear inside closeCreateForm()"
    ).toBe(1)
  })

  it("defaults the scope state to read", () => {
    expect(source).toMatch(/useState<"read"\s*\|\s*"write">\("read"\)/)
  })
})
