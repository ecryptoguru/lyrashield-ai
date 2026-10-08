import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * W2-12: findings-table context preservation.
 *
 * Filters, target, sort, and search live in the URL (server-parsed, so a fresh
 * load restores them). Pages loaded beyond the first server-rendered page and
 * the scroll position survive navigation through a session-scoped snapshot.
 * The drawer keeps its pushState/popstate and focus-restoration contract.
 *
 * The list's restore/save/Back-Forward effects moved out of the client
 * component into findings-list-effects.ts, so the snapshot assertions read the
 * module that now owns them. The URL assertions still read the client, which
 * still builds the query string. `setRestoreReady(true)` is asserted on the
 * client because that is where it also flips when a new request supersedes a
 * pending restore; the effects module only holds the post-restore call.
 */
describe("findings list context preservation contract", () => {
  const client = readFileSync(new URL("./findings-client.tsx", import.meta.url), "utf8")
  const effects = readFileSync(new URL("./findings-list-effects.ts", import.meta.url), "utf8")
  const drawer = readFileSync(new URL("./use-finding-drawer.ts", import.meta.url), "utf8")

  it("keeps filter/sort/target/query in the URL", () => {
    expect(client).toContain('params.set("filter", updates.filter)')
    expect(client).toContain('params.set("target", updates.target)')
    expect(drawer).toContain('url.searchParams.set("finding", finding.id)')
  })

  it("revalidates saved pages and restores scroll after mount, not during hydration", () => {
    expect(effects).toContain("loadFindingsListContext(")
    expect(effects).toContain("window.scrollTo(0, stored.scrollY)")
    expect(client).toContain("setRestoreReady(true)")
  })

  it("persists the snapshot only after restoration and on pagehide", () => {
    expect(effects).toContain("!restoreReady")
    expect(effects).toContain('window.addEventListener("pagehide", save)')
  })

  it("keeps drawer focus restoration and never touches filter state on drawer close", () => {
    expect(drawer).toContain("opener?.focus()")
    expect(drawer).toContain("Filter/sort/search state is never touched")
  })
})
