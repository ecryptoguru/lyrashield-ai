import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { Tabs } from "@/components/ui/tabs"
import { FindingHistoryTab } from "./finding-detail-tabs"

function render(hasStoredPatch: boolean, canCreatePr = true) {
  return renderToStaticMarkup(
    <Tabs defaultValue="history">
      <FindingHistoryTab
        detail={
          { fixProposals: [{ id: "p1", status: "ready", summary: "Fix", hasStoredPatch }] } as never
        }
        finding={
          {
            id: "f1",
            status: "OPEN",
            firstSeenAt: "2026-01-01T00:00:00Z",
            lastSeenAt: "2026-01-01T00:00:00Z",
          } as never
        }
        canCreatePr={canCreatePr}
        workspaceId="ws-1"
        historyLoading={new Set()}
        loadMoreHistory={async () => {}}
        historyError={null}
      />
    </Tabs>
  )
}

describe("finding history approval action", () => {
  it("requires permission and a stored patch", () => {
    expect(render(true)).toContain("Create pull request")
    expect(render(false)).not.toContain("Create pull request")
    expect(render(true, false)).not.toContain("Create pull request")
  })
})
