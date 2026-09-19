import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const source = readFileSync(new URL("./projects-client.tsx", import.meta.url), "utf8")

describe("projects empty state", () => {
  it("never renders alongside the open create form", () => {
    // DESIGN.md: one primary action per surface. Without the !showForm guard
    // the empty state and its own "New Project" button sit under the open
    // form and compete with it.
    const emptyStateBlock = source.slice(source.indexOf("<EmptyState"))
    expect(source).toContain("projects.length === 0 && !showForm")
    expect(emptyStateBlock).toContain("New Project")
  })
})
