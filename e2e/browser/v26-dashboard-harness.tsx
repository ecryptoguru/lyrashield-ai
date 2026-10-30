import { useState } from "react"
import type { ApprovalListItem } from "@lyrashield/db"
import { ApprovalsClient } from "../../apps/web/src/app/(dashboard)/dashboard/approvals/approvals-client"
import ResetPasswordPage from "../../apps/web/src/app/reset-password/page"
import { TargetsClient } from "../../apps/web/src/app/(dashboard)/dashboard/targets/targets-client"
import { TooltipProvider } from "../../apps/web/src/components/ui/tooltip"
import { ScanCapacityBanner } from "../../apps/web/src/app/(dashboard)/dashboard/scans/[id]/scan-capacity-banner"
import { GithubIntegration } from "../../apps/web/src/app/(dashboard)/dashboard/integrations/github-integration"
import { NotificationsClient } from "../../apps/web/src/app/(dashboard)/dashboard/notifications/notifications-client"
import { BuyPackButton } from "../../apps/web/src/app/(dashboard)/dashboard/billing/buy-pack-button"
import { NotificationPreferences } from "../../apps/web/src/components/notification-preferences"

export default function V26DashboardHarness() {
  const mode = new URLSearchParams(location.search).get("v26-dashboard")
  return (
    <main className="mx-auto max-w-4xl p-4">
      {mode === "approvals-pages" && <ApprovalPagesHarness />}
      {mode === "reset" && (
        <TooltipProvider>
          <ResetPasswordPage />
        </TooltipProvider>
      )}
      {mode === "targets" && (
        <TooltipProvider>
          <TargetsClient workspaceId="ws-test" initialData={[]} githubConnected />
        </TooltipProvider>
      )}
      {mode === "capacity" && (
        <ScanCapacityBanner
          scan={{
            status: "COMPLETED",
            capacity: {
              state: "SETTLED",
              executionStopped: true,
              admissionHeld: false,
              multiplier: 3,
              fundedMinutes: 9,
              runtimeLimitMs: 180000,
              observedMs: 61000,
              chargedMinutes: 6,
              absorbedMinutes: 0,
            },
          }}
        />
      )}
      {mode === "github" && (
        <GithubIntegration
          workspaceId="ws-test"
          connected
          accountLogin={{ accountLogin: "example" }}
          canManage={!new URLSearchParams(location.search).has("viewer")}
        />
      )}
      {mode === "notifications" && <NotificationsClient workspaceId="ws-test" />}
      {mode === "pack" && <BuyPackButton workspaceId="ws-test" />}
      {mode === "preferences" && <NotificationPreferences />}
    </main>
  )
}

function ApprovalPagesHarness() {
  const [pendingPage, setPendingPage] = useState("first")
  const [operationsPage, setOperationsPage] = useState(0)
  const approval = (id: string, title: string): ApprovalListItem => ({
    id,
    workspaceId: "ws-test",
    actionName: "fix_pr.open",
    inputHash: "fixture",
    status: "PENDING",
    attempts: 0,
    input: { title },
    requestedById: "fixture-user",
    approvedById: null,
    approvedAt: null,
    deniedAt: null,
    executedAt: null,
    expiresAt: null,
    createdAt: new Date("2026-10-30T00:00:00Z"),
    updatedAt: new Date("2026-10-30T00:00:00Z"),
  })
  const approvals =
    pendingPage === "second"
      ? [approval("approval-second", "Second page request")]
      : pendingPage === "latest"
        ? [approval("approval-latest", "Latest pending request")]
        : [
            approval("approval-first", "First pending request"),
            approval("approval-another", "Another pending request"),
          ]
  return (
    <section>
      <nav aria-label="Fixture activity navigation">
        <button type="button" onClick={() => setPendingPage("second")}>
          More pending approvals fixture
        </button>
        <button type="button" onClick={() => setPendingPage("latest")}>
          Latest activity fixture
        </button>
        <button type="button" onClick={() => setOperationsPage((value) => value + 1)}>
          Older operations fixture
        </button>
      </nav>
      <p>Operation page {operationsPage}</p>
      <ApprovalsClient
        workspaceId="ws-test"
        approvals={approvals}
        hasProposals={false}
        canDecide
        canApproveFix
        pendingCursor={pendingPage === "second" ? "page-two" : null}
      />
    </section>
  )
}
