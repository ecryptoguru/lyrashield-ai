import Link from "next/link"
import type { ComponentType, SVGProps } from "react"
import {
  Bell,
  CalendarClock,
  Plug,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react"
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  buttonVariants,
} from "@lyrashield/ui"
import { prisma } from "@lyrashield/db"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"

const securityControls = [
  "Workspace-scoped RBAC",
  "Request-scoped tenant filtering",
  "Nonce-based CSP",
  "PII-safe logging",
  "Rate limiting",
  "Audit logging",
]

export default async function SettingsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold tracking-tight">Settings</h1>
        <EmptyState
          icon={Settings}
          title="No workspace yet"
          description="Create a workspace during onboarding to manage settings."
        />
      </div>
    )
  }

  const [workspace, integrationCount, unreadNotifications, enabledSchedules] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        name: true,
        mode: true,
        plan: true,
        retentionDays: true,
        telemetryEnabled: true,
        _count: {
          select: {
            members: true,
            targets: true,
            scans: true,
            findings: true,
          },
        },
      },
    }),
    prisma.integration.count({ where: { workspaceId, deletedAt: null } }),
    prisma.notification.count({ where: { workspaceId, status: { not: "read" }, deletedAt: null } }),
    prisma.schedule.count({ where: { workspaceId, enabled: true, deletedAt: null } }),
  ])

  if (!workspace) return null

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Workspace posture, access, automation, and connected services.
          </p>
        </div>
        <Badge variant="info">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Controls active
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Metric label="Name" value={workspace.name} />
              <Metric label="Mode" value={workspace.mode} />
              <Metric label="Plan" value={workspace.plan} />
              <Metric label="Targets" value={workspace._count.targets.toString()} />
              <Metric label="Scans" value={workspace._count.scans.toString()} />
              <Metric label="Findings" value={workspace._count.findings.toString()} />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border bg-card/50 p-4">
                <p className="text-sm font-medium">Data retention</p>
                <p className="mt-1 text-sm text-muted-foreground">{workspace.retentionDays} days</p>
              </div>
              <div className="rounded-xl border bg-card/50 p-4">
                <p className="text-sm font-medium">Product telemetry</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {workspace.telemetryEnabled ? "Enabled for this workspace" : "Disabled for this workspace"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Security Controls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {securityControls.map((control) => (
              <div key={control} className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <span>{control}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SettingsLink
          href="/dashboard/team"
          icon={Users}
          title="Team Access"
          description={`${workspace._count.members} active member${workspace._count.members === 1 ? "" : "s"}`}
        />
        <SettingsLink
          href="/dashboard/integrations"
          icon={Plug}
          title="Integrations"
          description={`${integrationCount} connected service${integrationCount === 1 ? "" : "s"}`}
        />
        <SettingsLink
          href="/dashboard/notifications"
          icon={Bell}
          title="Notifications"
          description={`${unreadNotifications} unread notification${unreadNotifications === 1 ? "" : "s"}`}
        />
        <SettingsLink
          href="/dashboard/schedules"
          icon={CalendarClock}
          title="Schedules"
          description={`${enabledSchedules} active schedule${enabledSchedules === 1 ? "" : "s"}`}
        />
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card/50 p-4">
      <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold">{value}</p>
    </div>
  )
}

function SettingsLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  title: string
  description: string
}) {
  return (
    <Card className="transition-[border-color,box-shadow] hover:border-primary/50 hover:shadow-card-hover">
      <CardContent className="p-5">
        <Icon className="mb-4 h-5 w-5 text-primary" aria-hidden="true" />
        <h2 className="font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 min-h-10 text-sm text-muted-foreground">{description}</p>
        <Link className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-4 w-full" })} href={href}>
          Open
        </Link>
      </CardContent>
    </Card>
  )
}
