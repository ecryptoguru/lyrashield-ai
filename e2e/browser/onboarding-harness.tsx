import { OnboardingWizard } from "../../apps/web/src/app/onboarding/onboarding-wizard"

export default function OnboardingHarness() {
  const hint = new URLSearchParams(location.search).get("onboarding") === "api" ? "api" : "url"
  return (
    <main className="flex justify-center p-4 md:p-8">
      <OnboardingWizard
        principalId="browser-onboarding-user"
        targetTypeHint={hint}
        initialState={{
          currentStep: 1,
          completed: false,
          skipped: false,
          workspaceId: null,
          targetId: null,
          selectedGoal: null,
          updatedAt: "2026-10-09T00:00:00.000Z",
        }}
      />
    </main>
  )
}
