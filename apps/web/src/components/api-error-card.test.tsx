import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  return {
    default: ({ href, children, className }: { href: string; children: ReactNode; className: string }) =>
      React.createElement("a", { href, className }, children),
  }
})

import { ApiErrorCard, PAGE_LOAD_FAILURE_MESSAGE, safeApiErrorMessage } from "./api-error-card"

describe("safeApiErrorMessage", () => {
  it("removes control characters and bounds untrusted error text", () => {
    expect(safeApiErrorMessage("failed\u0000\ntry again")).toBe("failed  try again")
    expect(safeApiErrorMessage("x".repeat(600))).toBe(`${"x".repeat(500)}…`)
    expect(safeApiErrorMessage(undefined)).toBe("Unknown error")
  })
})

/**
 * W1/P2-7 — the boundary printed the raw error message and a digest block.
 * In production Next hands the boundary its generic "specific message is
 * omitted in production builds" sentence, which is not user copy.
 */
describe("dashboard error boundary copy (W1/P2-7)", () => {
  const FRAMEWORK_SENTENCE =
    "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details."

  it("never paints the raw message or the digest into the page", () => {
    const error = Object.assign(new Error(FRAMEWORK_SENTENCE), { digest: "1234567890abcdef" })
    const html = renderToStaticMarkup(<ApiErrorCard error={error} reset={() => {}} />)

    expect(html).toContain("We could not load this page")
    expect(html).toContain(PAGE_LOAD_FAILURE_MESSAGE)
    expect(html).not.toContain("Server Components render")
    expect(html).not.toContain("1234567890abcdef")
    expect(html).not.toContain("Error digest")
    // The digest stays reachable for support, behind the explicit copy action.
    expect(html).toContain("Copy details for support")
    expect(html).toContain("error digest that support can use")
  })

  it("keeps a message that is already user-facing out of the headline too", () => {
    const html = renderToStaticMarkup(
      <ApiErrorCard error={new Error("Prisma failed on workspace 42")} reset={() => {}} />
    )

    expect(html).not.toContain("Prisma")
    expect(html).not.toContain("workspace 42")
    expect(html).toContain(PAGE_LOAD_FAILURE_MESSAGE)
  })

  it("omits the digest note when the boundary reported no digest", () => {
    const html = renderToStaticMarkup(<ApiErrorCard error={new Error("Boom.")} reset={() => {}} />)

    expect(html).not.toContain("error digest")
  })

  it("renders a route recovery link when one is supplied", () => {
    const html = renderToStaticMarkup(
      <ApiErrorCard
        error={new Error("Boom.")}
        reset={() => {}}
        recovery={{ href: "/dashboard/scans", label: "Back to scans" }}
      />
    )

    expect(html).toContain('href="/dashboard/scans"')
    expect(html).toContain("Back to scans")
  })
})
