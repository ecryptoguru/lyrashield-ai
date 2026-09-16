import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import {
  MyraComponentView,
  MyraMarkdown,
  ProposalActions,
  type MyraComponentContext,
} from "./myra-presentation"

const context: MyraComponentContext = {
  onPickSlot: () => {},
  onConfirm: () => {},
  onCancel: () => {},
  onForgetMemory: () => {},
  proposalStates: {},
}

describe("MyraMarkdown", () => {
  it("renders paragraphs, lists, and fenced code in order", () => {
    const html = renderToStaticMarkup(
      <MyraMarkdown text={"intro line\n\n- first\n- second\n\n```\nconst x = 1\n```\n\ntail"} />
    )
    expect(html).toContain("<p")
    expect(html).toContain("intro line")
    expect(html).toContain("<ul")
    expect(html).toContain("<li><span>first</span></li>")
    expect(html).toContain("<pre")
    expect(html).toContain("const x = 1")
    expect(html.indexOf("intro line")).toBeLessThan(html.indexOf("first"))
    expect(html.indexOf("first")).toBeLessThan(html.indexOf("const x = 1"))
    expect(html.indexOf("const x = 1")).toBeLessThan(html.indexOf("tail"))
  })

  it("renders an allowed relative link and degrades a disallowed link without an anchor", () => {
    const html = renderToStaticMarkup(
      <MyraMarkdown text={"[docs](/dashboard/billing)\n\n[bad](javascript:alert(1))"} />
    )
    expect(html).toContain('href="/dashboard/billing"')
    expect(html).toContain("bad")
    expect(html).not.toContain("javascript:")
    expect((html.match(/<a /g) ?? []).length).toBe(1)
  })
})

describe("MyraComponentView", () => {
  it("renders diagnostic_status with title, check labels, and a manifest CTA", () => {
    const html = renderToStaticMarkup(
      <MyraComponentView
        component={{
          type: "diagnostic_status",
          title: "Workspace posture",
          checkedAt: "2026-09-16",
          checks: [
            { id: "a", label: "Billing reachable", status: "pass", ctaRoute: "/dashboard/billing" },
            { id: "b", label: "Scan queue", status: "fail", ctaRoute: "https://evil.example/x" },
          ],
        }}
        context={context}
      />
    )
    expect(html).toContain("Workspace posture")
    expect(html).toContain("Billing reachable")
    expect(html).toContain("Scan queue")
    expect(html).toContain('href="/dashboard/billing"')
    expect(html).not.toContain("evil.example")
  })
})

describe("ProposalActions", () => {
  it("renders done status text without action buttons", () => {
    const html = renderToStaticMarkup(
      <ProposalActions
        proposalId="p1"
        confirmLabel="Confirm"
        context={{
          ...context,
          proposalStates: { p1: { state: "done", statusText: "Done — sent." } },
        }}
      />
    )
    expect(html).toContain("Done — sent.")
    expect(html).not.toContain("<button")
  })

  it("renders cancelled copy without action buttons", () => {
    const html = renderToStaticMarkup(
      <ProposalActions
        proposalId="p2"
        context={{ ...context, proposalStates: { p2: { state: "cancelled" } } }}
      />
    )
    expect(html).toContain("Canceled — nothing was executed.")
    expect(html).not.toContain("<button")
  })
})
