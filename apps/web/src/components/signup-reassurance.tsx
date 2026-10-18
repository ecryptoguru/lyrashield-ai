import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"
import type { parsePlanIntent } from "@/lib/plan-intent"

export function SignupReassurance({ plan }: { plan: ReturnType<typeof parsePlanIntent> }) {
  const trial = CLOUD_PLAN_MAP.TRIAL
  return (
    <div className="bg-primary/5 mb-6 rounded-lg border border-primary/20 p-3 text-sm">
      {plan ? (
        <p>
          You selected <strong>{CLOUD_PLAN_MAP[plan].name}</strong>. Create your account first, then
          review billing and confirm your plan. No payment is taken here.
        </p>
      ) : (
        <>
          <p className="font-medium">
            {trial.trialDays}-day free trial · {trial.agentMinutes} agent-minutes ·{" "}
            {trial.targetCaps} targets · no card
          </p>
          <p className="text-muted-foreground mt-1">
            Safe, Quick and Standard scans. Deep and Custom require Pro or above.
          </p>
        </>
      )}
    </div>
  )
}
