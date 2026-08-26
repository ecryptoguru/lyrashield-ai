import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// apps/web has no component test harness; preserve server-navigation and request-volume behavior.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const client = readFileSync(new URL("./licenses-client.tsx", import.meta.url), "utf8")
// eslint-disable-next-line security/detect-non-literal-fs-filename
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")

describe("platform licenses filters", () => {
  it("refreshes server data on submit or filter change without querying per keystroke", () => {
    expect(client).toContain("router.replace(`/dashboard/licenses?${params.toString()}`)")
    expect(client).not.toContain("window.history.replaceState")
    expect(client).toContain("onChange={(event) => setSearch(event.target.value)}")
    expect(client).toContain("onSubmit={(event) =>")
  })

  it("keeps filters reachable when the selected result set is empty", () => {
    expect(page).toContain("<LicensesClient")
    expect(page).toContain("key={`${statusFilter}:${query}`}")
    expect(page).not.toContain("<NoWorkspaceState")
    expect(client).toContain("No {filter} licenses found")
  })

  it("exposes filter state and table structure to assistive technology", () => {
    expect(client).toContain('aria-pressed={filter === "active"}')
    expect(client).toContain('aria-pressed={filter === "revoked"}')
    expect(client).toContain('<caption className="sr-only">')
    expect(client.match(/scope="col"/g)).toHaveLength(7)
  })
})
