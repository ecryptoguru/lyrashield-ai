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
