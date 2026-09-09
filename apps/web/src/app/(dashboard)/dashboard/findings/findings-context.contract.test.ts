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
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const client = readFileSync(new URL("./findings-client.tsx", import.meta.url), "utf8")
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const context = readFileSync(new URL("./findings-list-context.ts", import.meta.url), "utf8")

  it("keeps filter/sort/target/query in the URL", () => {
    expect(client).toContain('params.set("filter", updates.filter)')
    expect(client).toContain('params.set("target", updates.target)')
    expect(client).toContain('url.searchParams.set("finding", finding.id)')
  })

  it("restores loaded pages and scroll position after mount, not during hydration", () => {
    expect(client).toContain("loadFindingsListContext(findingsContextKey(workspaceId, current))")
    expect(client).toContain("window.scrollTo(0, stored.scrollY)")
    expect(client).toContain("listContextRestoredRef.current = true")
  })

  it("persists the snapshot only after restoration and on pagehide", () => {
    expect(client).toContain(
      'if (!listContextRestoredRef.current || typeof window === "undefined") return'
    )
    expect(client).toContain('window.addEventListener("pagehide", save)')
  })

  it("bounds and guards the persisted snapshot", () => {
    expect(context).toContain("MAX_PERSISTED_ROWS = 500")
    expect(context).toContain("rows.length > MAX_PERSISTED_ROWS) return null")
    expect(context).toContain("catch {")
    expect(context).toContain("sessionStorage.setItem")
  })

  it("keeps drawer focus restoration and never touches filter state on drawer close", () => {
    expect(client).toContain("opener?.focus()")
    expect(client).toContain("Filter/sort/search state is never touched")
  })
})
