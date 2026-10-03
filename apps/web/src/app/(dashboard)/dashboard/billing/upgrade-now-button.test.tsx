import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import { expect, it, vi } from "vitest"

vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  return {
    default: ({
      href,
      children,
      className,
    }: {
      href: string
      children: ReactNode
      className: string
    }) => React.createElement("a", { href, className }, children),
  }
})

import { UpgradeNowButton } from "./upgrade-now-button"

it("routes Upgrade Now to the existing Pro plan picker", () => {
  const html = renderToStaticMarkup(<UpgradeNowButton />)

  expect(html).toContain('href="/dashboard/billing?plan=PRO"')
  expect(html).toContain("Upgrade Now")
  expect(html).not.toContain("<button")
})
