import { ConnectedClientCard } from "../../apps/web/src/app/(dashboard)/dashboard/connections/connected-client-card"
import { ProjectsClient } from "../../apps/web/src/app/(dashboard)/dashboard/projects/projects-client"
import { SchedulesClient } from "../../apps/web/src/app/(dashboard)/dashboard/schedules/schedules-client"
import { SpendLimitForm } from "../../apps/web/src/app/(dashboard)/dashboard/billing/spend-limit-form"
import { AiAssuranceClient } from "../../apps/web/src/app/(dashboard)/dashboard/ai-assurance/ai-assurance-client"
import { LicensesClient } from "../../apps/web/src/app/(dashboard)/dashboard/licenses/licenses-client"
import { ReportCard } from "../../apps/web/src/app/(dashboard)/dashboard/reports/reports-views"
import { ScoreTrend } from "../../apps/web/src/components/security-visuals"
import { Switch, FormField, Card, CardContent } from "@lyrashield/ui"
import { LaunchReadinessClient } from "../../apps/web/src/app/(dashboard)/dashboard/launch-readiness/launch-readiness-client"
import { WebMcpReceiptProvider } from "../../apps/web/src/components/webmcp/webmcp-receipt-provider"
import { FirstScanHarness } from "./first-scan-harness"
import { useState } from "react"

export default function DashboardUxHarness() {
  const params = new URLSearchParams(location.search)
  const mode = params.get("dashboard-ux")
  const [checked, setChecked] = useState(false)
  document.documentElement.classList.toggle("dark", params.get("theme") === "dark")
  return (
    <main
      className="mx-auto min-h-screen w-full min-w-0 max-w-4xl space-y-6 px-4 py-6"
      id="main-content"
    >
      {(mode === "connections" || mode === "overview") && (
        <section aria-labelledby="connections-title">
          <h1 id="connections-title" className="mb-4 text-2xl font-semibold">
            Connections
          </h1>
          <ul className="grid min-w-0 grid-cols-1 gap-2">
            <li className="min-w-0">
              <ConnectedClientCard
                workspaceId="workspace-test"
                userId="user-test"
                connection={{
                  id: "connection-test",
                  userId: "user-test",
                  clientType: "MCP",
                  clientName: "Averylongcodingagentclientwithanunbrokennameforreflowtesting",
                  scopes: ["lyrashield.read", "lyrashield.write"],
                  status: "ACTIVE",
                  createdAt: new Date("2026-10-01T00:00:00Z"),
                  lastSuccessfulOperationAt: null,
                  allTargets: true,
                  expiresAt: null,
                }}
              />
            </li>
          </ul>
        </section>
      )}
      {mode === "first-scan" && <FirstScanHarness />}
      {mode === "readiness" && (
        <WebMcpReceiptProvider>
          <LaunchReadinessClient
            workspaceId="workspace-test"
            initialReport={{
              state: "INSUFFICIENT_EVIDENCE",
              verdict: "NOT_EVALUATED",
              score: null,
              triageScore: null,
              summary: "Add a target and complete a scan before reviewing launch readiness.",
              blockingFindings: 0,
              totalFindings: 0,
              verifiedFindings: 0,
              bySeverity: {},
              conditions: ["No usable review evidence yet."],
              recommendations: ["Complete your first scan."],
            }}
            targets={[]}
            initialTargetId=""
            initialReleaseRef=""
            initialReleaseCheck={null}
            initialCheckError={null}
            checkNeedsTarget={false}
          />
        </WebMcpReceiptProvider>
      )}
      {mode === "projects" && <ProjectsClient workspaceId="workspace-test" initialData={[]} />}
      {mode === "schedules" && <SchedulesClient workspaceId="workspace-test" />}
      {mode === "assurance" && (
        <AiAssuranceClient
          workspaceId="workspace-test"
          targetId={null}
          targets={[]}
          initialItems={[]}
          canManage
          canReview
          initialProfile={null}
          initialThreatModel={null}
        />
      )}
      {(mode === "charts" || mode === "overview") && (
        <Card>
          <CardContent className="pt-6">
            <h2 className="mb-4 font-semibold">Score trend</h2>
            <ScoreTrend
              points={
                params.has("empty")
                  ? []
                  : params.has("single")
                    ? [{ label: "Oct 1, 2026", score: 62 }]
                    : [
                        { label: "Oct 1, 2026", score: 62 },
                        { label: "Oct 4, 2026", score: 58 },
                        { label: "Oct 8, 2026", score: 81 },
                      ]
              }
            />
          </CardContent>
        </Card>
      )}
      {(mode === "billing" || mode === "overview") && (
        <Card>
          <CardContent className="pt-6">
            <SpendLimitForm workspaceId="workspace-test" currentCents={1000} />
          </CardContent>
        </Card>
      )}
      {(mode === "reports" || mode === "overview") && (
        <ReportCard
          workspaceId="workspace-test"
          onShare={() => {}}
          onRevoke={() => {}}
          report={{
            id: "report-test",
            title: "Retained launch assurance report for checkout service",
            type: "launch_readiness",
            status: "generated",
            format: "html",
            shareExpiresAt: null,
            revokedAt: null,
            scanId: null,
            createdAt: "2026-10-08T00:00:00Z",
            provenance: {
              gateVerdictId: "gate-test",
              verdictChecksum: "checksum-test",
              assessmentVersion: 1,
              assessedIdentity: {
                kind: "COMMIT",
                value: "d4c070ad52dd7e8ca047fe775b53527244c8737d1234",
              },
              assessedAt: "2026-10-08T00:00:00Z",
              issuedAt: "2026-10-08T01:00:00Z",
              applicabilityCheckedAt: "2026-10-08T01:00:00Z",
              applicability: "applicable",
              reasonCodes: [],
              historicalState: "INSUFFICIENT_EVIDENCE",
              effectiveState: null,
            },
          }}
        />
      )}
      {(mode === "controls" || mode === "overview") && (
        <FormField label="Email notifications" htmlFor="notifications">
          <Switch id="notifications" checked={checked} onCheckedChange={setChecked} />
        </FormField>
      )}
      {mode === "licenses" && (
        <LicensesClient
          initialData={[]}
          query="owner+test@example.com"
          statusFilter="revoked"
          cursor="current-page"
          nextCursor="next-page"
        />
      )}
    </main>
  )
}
