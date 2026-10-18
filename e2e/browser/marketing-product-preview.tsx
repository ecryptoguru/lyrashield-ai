import { createRoot } from "react-dom/client"
import { TrustCommandCenter } from "../../apps/web/src/components/trust-command-center"
import { V2Sidebar } from "../../apps/web/src/components/v2-sidebar"
import { TooltipProvider } from "../../apps/web/src/components/ui/tooltip"
import { WebMcpReceiptProvider } from "../../apps/web/src/components/webmcp/webmcp-receipt-provider"
import { FindingsClient } from "../../apps/web/src/app/(dashboard)/dashboard/findings/findings-client"
import { AgentsHarness } from "./agents-harness"
import "../../apps/web/src/app/globals.css"
import "../../apps/marketing/node_modules/@fontsource-variable/inter/index.css"
document.body.style.fontFamily = '"Inter Variable", sans-serif'

// Capture the shipped components rather than a drawing of the old dashboard.
// All identities and findings below are synthetic; no account or API is needed.
const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle("dark", params.get("theme") === "dark")
const view = params.get("view") ?? "posture"

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <WebMcpReceiptProvider>
      <div className="bg-background text-foreground flex min-h-screen">
        <V2Sidebar
          userName="Example builder"
          userEmail="builder@example.invalid"
          workspaces={[
            {
              id: "example",
              name: "Example workspace",
              slug: "example",
              mode: "CLOUD",
              plan: "TRIAL",
              role: "OWNER",
            },
          ]}
          activeWorkspaceId="example"
        />
        <main className="min-w-0 flex-1 space-y-6 p-8" data-product-capture>
          <p className="text-muted-foreground text-xs">
            Current dashboard components · Illustrative data
          </p>
          {view === "posture" && (
            <>
              <header>
                <h1 className="text-4xl font-bold tracking-tight">What needs your attention?</h1>
                <p className="text-muted-foreground mt-2 text-sm">
                  Start with the next decision, then use the evidence below when you need detail.
                </p>
              </header>
              <TrustCommandCenter
                productName="Example workspace"
                mode="STANDARD"
                trustPlanData={null}
                gate={{ state: "INSUFFICIENT_EVIDENCE", coverageLabel: "1/1 partial assessment" }}
                targetScope="1 authorized example target"
                latestAssessment={null}
                limitations={[
                  "Retest coverage is incomplete.",
                  "Operational evidence still needs review.",
                ]}
                latestScore={null}
              />
            </>
          )}
          {view === "findings" && (
            <FindingsClient
              workspaceId="example"
              initialData={[
                {
                  id: "EX-014",
                  title: "Missing rate limit on login route — example",
                  summary:
                    "Illustrative observation only. This is not a real vulnerability report.",
                  severity: "HIGH",
                  status: "OPEN",
                  verified: false,
                  verificationStatus: "NOT_VERIFIED",
                  confidence: "medium",
                  firstSeenAt: "2026-10-09T00:00:00.000Z",
                  lastSeenAt: "2026-10-09T00:00:00.000Z",
                },
              ]}
              initialNextCursor={null}
              targets={[{ id: "example-target", name: "Authorized example target" }]}
            />
          )}
          {view === "agents" && <AgentsHarness />}
        </main>
      </div>
    </WebMcpReceiptProvider>
  </TooltipProvider>
)
