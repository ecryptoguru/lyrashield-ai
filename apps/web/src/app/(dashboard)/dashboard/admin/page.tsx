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
