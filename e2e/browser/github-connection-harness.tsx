import { GitHubInstallationChooser } from "../../apps/web/src/app/integrations/github/choose/chooser"
import { OnboardingWizard } from "../../apps/web/src/app/onboarding/onboarding-wizard"

export default function GitHubConnectionHarness() {
  const params = new URLSearchParams(location.search)
  if (params.get("github-connection") === "choose")
    return (
      <GitHubInstallationChooser
        state="signed-chooser-fixture"
        workspaceId="ws-browser"
        candidates={[
          { id: 777, login: "<img src=x onerror=alert(1)>" },
          { id: 888, login: "acme" },
        ]}
        returnPath="?github-connection=recovery&github=cancelled"
      />
    )
  return (
    <main className="flex justify-center p-4 md:p-8">
      <OnboardingWizard
        principalId="browser-user"
        githubStatus={params.get("github") ?? "already_claimed"}
        canManageGitHub={params.get("member") !== "no"}
        oauthReturnState="signed-mcp-return-fixture"
        initialState={{
          currentStep: 2,
          completed: false,
          skipped: false,
          workspaceId: "ws-browser",
          targetId: null,
          selectedGoal: null,
          updatedAt: "2026-10-26T00:00:00Z",
        }}
      />
    </main>
  )
}
