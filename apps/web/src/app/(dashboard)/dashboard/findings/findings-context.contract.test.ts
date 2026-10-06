import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * W2-12: findings-table context preservation.
 *
 * Filters, target, sort, and search live in the URL (server-parsed, so a fresh
 * load restores them). Pages loaded beyond the first server-rendered page and
 * the scroll position survive navigation through a session-scoped snapshot.
 * The drawer keeps its pushState/popstate and focus-restoration contract.
 */
describe("findings list context preservation contract", () => {
  const client = readFileSync(new URL("./findings-client.tsx", import.meta.url), "utf8")
  const drawer = readFileSync(new URL("./use-finding-drawer.ts", import.meta.url), "utf8")

  it("keeps filter/sort/target/query in the URL", () => {
    expect(client).toContain('params.set("filter", updates.filter)')
    expect(client).toContain('params.set("target", updates.target)')
    expect(drawer).toContain('url.searchParams.set("finding", finding.id)')
  })

  it("revalidates saved pages and restores scroll after mount, not during hydration", () => {
    expect(client).toContain("loadFindingsListContext(")
    expect(client).toContain("window.scrollTo(0, stored.scrollY)")
    expect(client).toContain("setRestoreReady(true)")
  })

  it("persists the snapshot only after restoration and on pagehide", () => {
    expect(client).toContain("!restoreReady")
    expect(client).toContain('window.addEventListener("pagehide", save)')
  })

  it("keeps drawer focus restoration and never touches filter state on drawer close", () => {
    expect(drawer).toContain("opener?.focus()")
    expect(drawer).toContain("Filter/sort/search state is never touched")
  })
})
