import { useState } from "react"
import { ApprovalsClient } from "../../apps/web/src/app/(dashboard)/dashboard/approvals/approvals-client"
import type { ApprovalListItem } from "@lyrashield/db"

export default function ApprovalsHarness() {
  const [expiresAt] = useState(() => new Date(Date.now() + 60_000))
  return (
    <main className="mx-auto max-w-3xl p-4">
      <ApprovalsClient
        workspaceId="workspace-test"
        canDecide
        canApproveFix
        hasProposals={false}
        approvals={[
          {
            id: "approval-live",
            actionName: "fix_pr.open",
            input: { title: "Controlled Composer update" },
            expiresAt,
          } as unknown as ApprovalListItem,
        ]}
      />
    </main>
  )
}
