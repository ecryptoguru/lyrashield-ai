import type { ComponentProps } from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { Tabs } from "@/components/ui/tabs"
import { FindingActionTab } from "./finding-action-tab"

type Props = ComponentProps<typeof FindingActionTab>
const noop = vi.fn()
const props: Props = {
  finding: {
    id: "finding",
    title: "Affected dependency",
    severity: "MEDIUM",
    status: "OPEN",
    summary: "Upgrade the dependency",
    verified: false,
    verificationStatus: "DETECTED",
    confidence: "HIGH",
    firstSeenAt: "2026-10-25T00:00:00Z",
    lastSeenAt: "2026-10-25T00:00:00Z",
  },
  detail: {
    id: "finding",
    title: "Affected dependency",
    summary: "Upgrade the dependency",
    scanId: "scan",
    fixProposals: [{ id: "proposal", status: "failed", summary: "Generation failed" }],
  },
  audienceMode: "developer",
  setAudienceMode: noop,
  showFixForm: false,
  setShowFixForm: noop,
  fixSummary: "",
  setFixSummary: noop,
  creatingFix: false,
  fixError: null,
  setFixError: noop,
  saveFixProposal: async () => {},
  creatingRetest: false,
  retestError: null,
  queuedRetestScanId: null,
  queueRetest: async () => {},
  setDetailTab: noop,
  showAcceptRisk: false,
  setShowAcceptRisk: noop,
  showFalsePositive: false,
  setShowFalsePositive: noop,
  patchLoading: false,
  patchError: null,
  setPatchError: noop,
  handleAcceptRisk: async () => {},
  handleFalsePositive: async () => {},
}
function render(detail: Partial<Props["detail"]> = {}) {
  return renderToString(
    <Tabs defaultValue="what-to-do">
      <FindingActionTab {...props} detail={{ ...props.detail, ...detail }} />
    </Tabs>
  )
}
describe("failed fix proposal recovery", () => {
  it("offers a new proposal when generation failed instead of claiming a change is ready to apply", () => {
    const html = render()
    expect(html).toContain("Create fix proposal")
    expect(html).not.toContain("Apply the change, then run a fresh retest")
  })
  it("keeps a recorded ready proposal on the retest path", () => {
    expect(
      render({ fixProposals: [{ id: "ready", status: "ready", summary: "Update dependency" }] })
    ).toContain("Queue fresh retest")
  })
  it("shows a running retest before allowing another proposal", () => {
    const html = render({
      retests: [
        { id: "retest", scanId: "scan", status: "running", createdAt: "2026-10-25T00:00:00Z" },
      ],
    })
    expect(html).toContain("Retest in progress")
    expect(html).not.toContain("Create fix proposal")
  })
})
