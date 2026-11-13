import { OnboardingWizard } from "../../apps/web/src/app/onboarding/onboarding-wizard"

export default function OnboardingHarness() {
  const params = new URLSearchParams(location.search)
  const hint = params.get("onboarding") === "api" ? "api" : "url"
  const recovering = params.has("onboarding-recovery")
  return (
    <main className="flex justify-center p-4 md:p-8">
      <OnboardingWizard
        principalId="browser-onboarding-user"
        targetTypeHint={hint}
        workspaceChoices={[
          { id: "ws-first", name: "Alpha", role: "OWNER" },
          { id: "ws-selected", name: "Beta", role: "DEVELOPER" },
        ]}
        initialState={{
          currentStep: 1,
          completed: false,
          skipped: false,
          workspaceId: recovering ? "ws-selected" : null,
          targetId: null,
          selectedGoal: null,
          updatedAt: "2026-10-09T00:00:00.000Z",
        }}
      />
    </main>
  )
}
