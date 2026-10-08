import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  return {
    default: ({ href, children }: { href: string; children: ReactNode }) =>
      React.createElement("a", { href }, children),
  }
})

import FindingsError from "./error"
import { PAGE_LOAD_FAILURE_MESSAGE } from "@/components/api-error-card"

/**
 * W1/P2-7 — a route boundary is added only where recovery needs one. Findings
 * is that route: the list query, the target filter list and a deep-linked
 * finding are three independent reads, and any of them failing blanks a page
 * that otherwise has a working list to return to.
 */
describe("findings route boundary", () => {
  it("offers a retry and a way back to the unscoped list", () => {
    const html = renderToStaticMarkup(
      <FindingsError error={new Error("Boom")} reset={() => {}} />
    )

    expect(html).toContain(PAGE_LOAD_FAILURE_MESSAGE)
    expect(html).toContain("Try again")
    expect(html).toContain('href="/dashboard/findings?tab=issues"')
    expect(html).toContain("All workspace findings")
  })

  it("does not print the raw error text", () => {
    const html = renderToStaticMarkup(
      <FindingsError
        error={Object.assign(new Error("Prisma P2025 on workspace ws-1"), { digest: "deadbeef" })}
        reset={() => {}}
      />
    )

    expect(html).not.toContain("Prisma")
    expect(html).not.toContain("deadbeef")
  })
})
