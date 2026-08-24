import { CreditCard, Clock, Zap, AlertCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, Badge, buttonVariants } from "@lyrashield/ui"
import { prisma } from "@lyrashield/db"
import {
  getUsageBalance,
  getTrialState,
  getGraceState,
  CLOUD_PLAN_MAP,
  resolveProvider,
} from "@lyrashield/billing"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { BillingActions } from "./billing-actions"
import { BuyPackButton } from "./buy-pack-button"
import { UpgradeNowButton } from "./upgrade-now-button"
import { SpendLimitForm } from "./spend-limit-form"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"
import Link from "next/link"
import { headers } from "next/headers"
import { getRequestBillingAdmission } from "@/lib/billing-admission"

export default async function BillingPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader title="Billing" description="Manage your plan, usage, and minute packs." />
        <NoWorkspaceState
          icon={CreditCard}
          description="Create a workspace during onboarding to manage billing."
        />
      </div>
    )
  }

  // Check billing permission
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: session.userId } },
    select: { role: true },
  })

  const canManageBilling = membership && hasPermission(membership.role, PERMISSIONS.billing.manage)
  const requestHeaders = await headers()
  const billingRequest = new Request("https://app.lyrashieldai.com/dashboard/billing", {
    headers: requestHeaders,
  })
  const { provider: checkoutProvider } = resolveProvider(billingRequest)
  const purchasesAvailable = getRequestBillingAdmission(
    checkoutProvider,
    workspaceId,
    billingRequest
  ).allowed

  const [billingAccount, balance, trialState, graceState] = await Promise.all([
    prisma.billingAccount.findUnique({
      where: { workspaceId },
      select: {
        currentPlan: true,
        status: true,
        interval: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        canceledAt: true,
        provider: true,
        spendLimitCents: true,
      },
    }),
    getUsageBalance(workspaceId),
    getTrialState(workspaceId),
    getGraceState(workspaceId),
  ])

  const plan = billingAccount?.currentPlan ?? "FREE"
  const cloudPlan = CLOUD_PLAN_MAP[plan as keyof typeof CLOUD_PLAN_MAP]
  const isTrial = trialState.isActive
  const isTeam = plan === "TEAM"

  return (
    <div>
      <PageHeader
        title="Billing"
        description="Manage your plan, usage, and minute packs."
        icon={CreditCard}
      />

      <div className="space-y-6">
        {canManageBilling && !purchasesAvailable && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">New purchases are temporarily unavailable</p>
              <p>Your current subscription and management access are unchanged.</p>
            </div>
          </div>
        )}
        {/* Plan Overview */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Current Plan</span>
              {isTrial && <Badge variant="muted">Trial</Badge>}
              {billingAccount?.status === "canceled" && <Badge variant="danger">Canceled</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold">{cloudPlan?.name ?? plan}</p>
                {billingAccount?.interval && (
                  <p className="text-sm text-muted-foreground">
                    {billingAccount.interval === "annual" ? "Annual billing" : "Monthly billing"}
                  </p>
                )}
              </div>
              {canManageBilling && (
                <BillingActions
                  plan={plan}
                  isTeam={isTeam}
                  workspaceId={workspaceId}
                  purchasesAvailable={purchasesAvailable}
                />
              )}
            </div>

            {billingAccount?.currentPeriodEnd && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span>
                  {billingAccount.canceledAt
                    ? `Access until ${billingAccount.currentPeriodEnd.toLocaleDateString()}`
                    : `Renews on ${billingAccount.currentPeriodEnd.toLocaleDateString()}`}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Trial Status */}
        {isTrial && (
          <Card>
            <CardHeader>
              <CardTitle>Trial Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-sm text-muted-foreground">Days Left</p>
                  <p className="text-xl font-semibold">{trialState.daysLeft}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Minutes Left</p>
                  <p className="text-xl font-semibold">{trialState.minutesLeft}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Targets</p>
                  <p className="text-xl font-semibold">
                    {trialState.targetsUsed} / {trialState.targetCap}
                  </p>
                </div>
              </div>
              {trialState.isExpired && (
                <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  <span>
                    {purchasesAvailable
                      ? "Your trial has expired. Upgrade to continue scanning."
                      : "Your trial has expired. New purchases are temporarily unavailable."}
                  </span>
                </div>
              )}
              {!trialState.isExpired && purchasesAvailable && (
                <UpgradeNowButton workspaceId={workspaceId} />
              )}
            </CardContent>
          </Card>
        )}

        {/* Usage */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Agent-Minute Usage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <p className="text-sm text-muted-foreground">Pool Minutes</p>
                <p className="text-xl font-semibold">
                  {balance.poolConsumed} / {balance.poolMinutes}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Pack Minutes</p>
                <p className="text-xl font-semibold">{balance.packRemaining}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Remaining</p>
                <p className="text-xl font-semibold">{balance.totalRemaining}</p>
              </div>
            </div>

            {/* Usage bar */}
            <div className="space-y-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{
                    width: `${
                      balance.poolMinutes > 0
                        ? Math.min(100, (balance.poolConsumed / balance.poolMinutes) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Agent-minutes are measured as wall-clock time. Deep/Custom scans consume 3× minutes.
              </p>
            </div>

            {/* Grace state */}
            {graceState.inGrace && (
              <div className="flex items-center gap-2 rounded-md bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
                <AlertCircle className="h-4 w-4" />
                <span>
                  Grace period active: {Math.ceil(graceState.remainingMs / 60_000)} minutes
                  remaining.
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Minute Packs */}
        <Card>
          <CardHeader>
            <CardTitle>Minute Packs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {balance.packs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {purchasesAvailable
                  ? "No active minute packs. Buy a pack to add agent-minutes to your account."
                  : "No active minute packs."}
              </p>
            ) : (
              <div className="space-y-2">
                {balance.packs.map((pack) => (
                  <div
                    key={pack.id}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <div>
                      <p className="font-medium">{pack.remainingMinutes} minutes remaining</p>
                      <p className="text-xs text-muted-foreground">
                        Purchased {pack.purchasedAt.toLocaleDateString()}
                        {pack.expiresAt && ` · Expires ${pack.expiresAt.toLocaleDateString()}`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {canManageBilling && purchasesAvailable && <BuyPackButton workspaceId={workspaceId} />}
          </CardContent>
        </Card>

        {/* Team Spend Limit */}
        {isTeam && canManageBilling && (
          <Card>
            <CardHeader>
              <CardTitle>Overage Spend Limit</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Set a monthly spend limit for overage minutes (beyond your included pool). Overage
                is billed at $0.15/min.
              </p>
              <SpendLimitForm
                workspaceId={workspaceId}
                currentCents={billingAccount?.spendLimitCents ?? null}
              />
            </CardContent>
          </Card>
        )}

        {/* Portal Link */}
        {canManageBilling && billingAccount?.provider === "polar" && (
          <Card>
            <CardHeader>
              <CardTitle>Manage Subscription</CardTitle>
            </CardHeader>
            <CardContent>
              <Link
                href={`/billing/portal?workspaceId=${encodeURIComponent(workspaceId)}`}
                className={`${buttonVariants({ variant: "outline" })} w-full`}
              >
                Open Customer Portal
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
