import { AlertCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@lyrashield/ui"
import { UpgradeNowButton } from "./upgrade-now-button"

interface TrialStatusCardProps {
  trial: {
    isActive: boolean
    isExpired: boolean
    daysLeft: number
    targetCap: number
  }
  effectivePlan: string
  displayedMinutesLeft: number
  workspaceTargetCount: number
  purchasesAvailable: boolean
  canManageBilling: boolean
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US")

export function TrialStatusCard({
  trial,
  effectivePlan,
  displayedMinutesLeft,
  workspaceTargetCount,
  purchasesAvailable,
  canManageBilling,
}: TrialStatusCardProps) {
  if (!(trial.isActive || (trial.isExpired && effectivePlan === "FREE"))) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Trial Status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-sm text-muted-foreground">Days Left</p>
            <p className="text-xl font-semibold">{NUMBER_FORMAT.format(trial.daysLeft)}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Minutes Left</p>
            <p className="text-xl font-semibold">{NUMBER_FORMAT.format(displayedMinutesLeft)}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Targets</p>
            <p className="text-xl font-semibold">
              {NUMBER_FORMAT.format(workspaceTargetCount)} / {NUMBER_FORMAT.format(trial.targetCap)}
            </p>
          </div>
        </div>
        {trial.isExpired && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <span>
              {purchasesAvailable
                ? "Your trial has expired. Unused trial minutes were forfeited. Upgrade to continue scanning."
                : "Your trial has expired. New purchases are temporarily unavailable."}
            </span>
          </div>
        )}
        {canManageBilling && !trial.isExpired && purchasesAvailable && <UpgradeNowButton />}
      </CardContent>
    </Card>
  )
}
