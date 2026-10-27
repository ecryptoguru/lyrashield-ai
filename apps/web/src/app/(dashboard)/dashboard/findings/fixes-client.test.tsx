import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FixesClient } from "./fixes-client"
import { TooltipProvider } from "@/components/ui/tooltip"

const proposal = {
  id: "proposal-php",
  kind: "composer_update",
  summary: "Update the affected package.\n\nManual guidance: <review every constraint>.",
  status: "ready",
  createdAt: "2026-10-23T00:00:00Z",
  finding: {
    id: "finding-php",
    title: "Affected Composer dependency",
    severity: "HIGH",
    status: "OPEN",
  },
  pullRequests: [],
}

function render(overrides = {}, canCreatePr = false) {
  return renderToString(
    <TooltipProvider>
      <FixesClient
        workspaceId="workspace-test"
        canCreatePr={canCreatePr}
        initialData={[{ ...proposal, ...overrides }]}
        initialNextCursor={null}
      />
    </TooltipProvider>
  )
}

describe("proposed fix review clarity", () => {
  it("presents reported scores as review context rather than safety verification", () => {
    const html = render({ safetyScore: 95 })
    expect(html).toContain("Review score: ")
    expect(html).not.toContain("Safety:")
    expect(html).toContain("What the review score means")
  })
  it("keeps Composer compatibility uncertainty visible before opening details", () => {
    const html = render()
    expect(html).toContain("Ready for review")
    expect(html).toContain("Application compatibility is unverified.")
    expect(html).toContain("draft pull request")
  })

  it("makes the full escaped summary available in a native disclosure", () => {
    const html = render()
    expect(html).toContain("Review full proposal")
    expect(html).toContain("<details")
    expect(html).not.toContain("<details open")
    expect(html).toContain("&lt;review every constraint&gt;")
    expect(html).toContain('role="article"')
  })

  it("distinguishes generation failure from a reviewable proposal", () => {
    expect(render({ status: "failed", kind: "patch" })).toContain("Generation failed")
    expect(render({ status: "failed", kind: "patch" })).not.toContain(
      "Application compatibility is unverified."
    )
  })
})

describe("pull request approval from a proposal", () => {
  it("offers the existing approval action for an authorized member with a ready stored patch", () => {
    expect(render({ hasStoredPatch: true }, true)).toContain("Create pull request")
  })

  it("hides the action without permission, a stored patch, or a ready proposal", () => {
    expect(render({ hasStoredPatch: true }, false)).not.toContain("Create pull request")
    expect(render({ hasStoredPatch: false }, true)).not.toContain("Create pull request")
    expect(render({ hasStoredPatch: true, status: "failed" }, true)).not.toContain(
      "Create pull request"
    )
  })
})
