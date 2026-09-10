import type { Metadata } from "next"
import Link from "next/link"
import { Activity, Building2, CircleDollarSign, ListTodo, Radar, Users } from "lucide-react"
import { Badge, Card, buttonVariants } from "@lyrashield/ui"
import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { notFound } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { getPlatformAdminOverview, type PlatformHealthStatus } from "@/lib/platform-admin-overview"

export const dynamic = "force-dynamic"

function statusVariant(status: PlatformHealthStatus) {
  if (status === "healthy") return "success" as const
  if (status === "degraded") return "warning" as const
  return "muted" as const
}

function count(value: number | null): string {
  return value === null ? "Unknown" : value.toLocaleString()
}

function AdminCard({
  title,
  status,
  icon: Icon,
  children,
}: {
  title: string
  status: PlatformHealthStatus
  icon: typeof Activity
  children: React.ReactNode
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="text-primary size-4" aria-hidden="true" />
          <h2 className="font-semibold">{title}</h2>
        </div>
        <Badge variant={statusVariant(status)}>{status}</Badge>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">{children}</dl>
    </Card>
  )
}

function Datum({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{count(value)}</dd>
    </div>
  )
}

function sampledRate(
  metric: { numerator: number; denominator: number; percent: number | null },
  minimum: number
) {
  return metric.percent === null
    ? `Insufficient sample (${metric.denominator}/${minimum})`
    : `${metric.percent}% (${metric.numerator}/${metric.denominator})`
}

export const metadata: Metadata = {
  title: "Platform Admin",
}

export default async function PlatformAdminPage() {
  try {
    await requirePlatformAdminIdentity()
  } catch {
    notFound()
  }
  const overview = await getPlatformAdminOverview()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platform Admin"
        description="Cross-platform health and bounded operational state. Customer payloads and secrets are not shown."
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-warning bg-warning/10 p-4 text-sm">
        <p>
          Global health is live. Affiliate mutations remain read-only until operation-specific
          elevation and atomic platform audit controls are connected.
        </p>
        <p className="text-muted-foreground text-xs">
          Refreshed {new Date(overview.generatedAt).toLocaleString()}
        </p>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Platform health">
        <AdminCard title="Database" status={overview.database.status} icon={Building2}>
          <Datum label="Users" value={overview.database.users} />
          <Datum label="Workspaces" value={overview.database.workspaces} />
          <Datum label="Targets" value={overview.database.targets} />
        </AdminCard>

        <AdminCard title="Scans" status={overview.scans.status} icon={Radar}>
          <Datum label="Queued" value={overview.scans.queued} />
          <Datum label="Running" value={overview.scans.active} />
          <Datum label="Completed" value={overview.scans.completed} />
          <Datum label="Failed" value={overview.scans.failed} />
        </AdminCard>

        <AdminCard title="Worker" status={overview.worker.status} icon={Activity}>
          <Datum
            label="Available"
            value={overview.worker.available === null ? null : overview.worker.available ? 1 : 0}
          />
        </AdminCard>

        <AdminCard title="Queue" status={overview.queue.status} icon={ListTodo}>
          <Datum label="Waiting" value={overview.queue.waiting} />
          <Datum label="Active" value={overview.queue.active} />
          <Datum label="Delayed" value={overview.queue.delayed} />
          <Datum label="Failed" value={overview.queue.failed} />
        </AdminCard>

        <AdminCard title="Billing" status={overview.billing.status} icon={CircleDollarSign}>
          <Datum label="Active" value={overview.billing.active} />
          <Datum label="Free" value={overview.billing.free} />
          <Datum label="Dead letters" value={overview.billing.deadLetters} />
        </AdminCard>

        <AdminCard title="Affiliates" status={overview.affiliates.status} icon={Users}>
          <Datum label="Applications" value={overview.affiliates.pendingApplications} />
          <Datum label="Pending payouts" value={overview.affiliates.pendingPayouts} />
        </AdminCard>
      </section>

      {overview.activation && (
        <section aria-labelledby="activation-heading">
          <div className="mb-3">
            <h2 id="activation-heading" className="text-lg font-semibold">
              Activation
            </h2>
            <p className="text-muted-foreground text-sm">
              Headline activation is accounts with a server-recorded COMPLETED or PARTIAL scan
              divided by accounts created:{" "}
              {sampledRate(overview.activation.activation, overview.activation.minimumSample)}.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Card className="p-5">
              <h3 className="font-semibold">Setup abandonment</h3>
              <p className="mt-2 text-xl font-semibold tabular-nums">
                {sampledRate(
                  overview.activation.setupAbandonment,
                  overview.activation.minimumSample
                )}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                Accounts created that never started a server-recorded scan divided by all accounts
                created.
              </p>
            </Card>
            <Card className="p-5">
              <h3 className="font-semibold">Time to first valid assessment</h3>
              <p className="mt-2 text-xl font-semibold tabular-nums">
                {overview.activation.timeToFirstValidAssessment.medianMinutes === null
                  ? `Insufficient sample (${overview.activation.timeToFirstValidAssessment.denominator}/${overview.activation.minimumSample})`
                  : `${overview.activation.timeToFirstValidAssessment.medianMinutes.toFixed(1)}m median · ${overview.activation.timeToFirstValidAssessment.p90Minutes?.toFixed(1)}m p90`}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                Account creation to its first server-recorded COMPLETED or PARTIAL scan.
                Denominator: accounts reaching that state.
              </p>
            </Card>
            <Card className="p-5">
              <h3 className="font-semibold">Connection success</h3>
              <p className="mt-2 text-xl font-semibold tabular-nums">
                {sampledRate(
                  overview.activation.connectionSuccess,
                  overview.activation.minimumSample
                )}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                Unique users with a GitHub connection completion divided by unique users who started
                the signed install flow.
              </p>
            </Card>
            <Card className="p-5">
              <h3 className="font-semibold">Repeated input</h3>
              <p className="mt-2 text-base font-semibold tabular-nums">
                {overview.activation.repeatedInput.sufficient
                  ? `0: ${overview.activation.repeatedInput.zero} · 1: ${overview.activation.repeatedInput.one} · 2: ${overview.activation.repeatedInput.two} · 3+: ${overview.activation.repeatedInput.threePlus}`
                  : `Insufficient sample (${overview.activation.repeatedInput.denominator}/${overview.activation.minimumSample})`}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                Distribution of targets created per account during the first 30 minutes after
                account creation. Denominator: accounts created.
              </p>
            </Card>
            <Card className="p-5">
              <h3 className="font-semibold">Recovery success</h3>
              <p className="mt-2 text-xl font-semibold tabular-nums">
                {sampledRate(
                  overview.activation.recoverySuccess,
                  overview.activation.minimumSample
                )}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                Agent operations with a structured failure reason followed by a successful operation
                of the same type and principal within 30 minutes divided by those failures.
              </p>
            </Card>
            <Card className="p-5">
              <h3 className="font-semibold">Repeat assessment</h3>
              <p className="mt-2 text-base font-semibold tabular-nums">
                7d:{" "}
                {sampledRate(
                  overview.activation.repeatAssessment.sevenDays,
                  overview.activation.minimumSample
                )}
                <br />
                28d:{" "}
                {sampledRate(
                  overview.activation.repeatAssessment.twentyEightDays,
                  overview.activation.minimumSample
                )}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                Accounts with a second COMPLETED scan inside 7 or 28 days divided by accounts with
                at least one COMPLETED scan.
              </p>
            </Card>
          </div>
        </section>
      )}

      <section className="flex flex-wrap gap-3" aria-label="Admin destinations">
        <Link
          href="/dashboard/admin/affiliates"
          className={buttonVariants({ variant: "secondary" })}
        >
          Review affiliates
        </Link>
        <Link
          href="/dashboard/launch-readiness"
          className={buttonVariants({ variant: "secondary" })}
        >
          Review launch readiness
        </Link>
      </section>
    </div>
  )
}
