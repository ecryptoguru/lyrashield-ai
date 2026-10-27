import { FixesClient } from "../../apps/web/src/app/(dashboard)/dashboard/findings/fixes-client"
import { TooltipProvider } from "../../apps/web/src/components/ui/tooltip"

export default function FixProposalsHarness() {
  document.documentElement.classList.toggle(
    "dark",
    new URLSearchParams(location.search).get("theme") === "dark"
  )
  return (
    <main className="mx-auto max-w-3xl p-4">
      <h1 className="mb-4 text-2xl font-semibold">Proposed fixes</h1>
      <TooltipProvider>
        <FixesClient
          workspaceId="workspace-test"
          canCreatePr={new URLSearchParams(location.search).get("noPermission") !== "1"}
          initialNextCursor={
            new URLSearchParams(location.search).has("withMore") ? "cursor-test" : null
          }
          initialData={[
            {
              id: "composer-ready",
              kind: "composer_update",
              status: "ready",
              hasStoredPatch: true,
              safetyScore: 95,
              summary:
                "Update the affected Composer package after reviewing its advisory and locked release.\n\n" +
                "Review the exact dependency changes and the target platform requirements. ".repeat(
                  8
                ) +
                "\n\nRun the project's compatibility tests before marking the draft ready for merge.",
              createdAt: "2026-10-23T00:00:00Z",
              pullRequests: [],
              finding: {
                id: "composer-finding",
                title: "Affected Composer dependency requiring application compatibility review",
                severity: "HIGH",
                status: "FIX_READY",
              },
            },
            {
              id: "summary-only",
              kind: "patch",
              status: "ready",
              hasStoredPatch: false,
              summary: "Review this guidance.",
              createdAt: "2026-10-23T00:00:00Z",
              pullRequests: [],
              finding: {
                id: "summary-finding",
                title: "Summary only",
                severity: "LOW",
                status: "OPEN",
              },
            },
            {
              id: "resolver-failed",
              kind: "patch",
              status: "failed",
              summary:
                "Fix generation could not complete after retries.\n\nCheck metadata access, resolver availability and evidence storage, then request a new proposal.\n\nEvidence reference: " +
                "reference".repeat(25),
              createdAt: "2026-10-23T00:00:00Z",
              pullRequests: [],
              finding: {
                id: "failed-finding",
                title: "Dependency update needs another attempt",
                severity: "HIGH",
                status: "OPEN",
              },
            },
          ]}
        />
      </TooltipProvider>
    </main>
  )
}
