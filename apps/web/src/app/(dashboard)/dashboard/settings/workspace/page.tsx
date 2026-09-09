import type { Metadata } from "next"
import Link from "next/link"
import type { ComponentType, SVGProps } from "react"
import { Bell, CalendarClock, Plug, Settings, Users } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@lyrashield/ui"
import { prisma } from "@lyrashield/db"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { ApiKeysSection } from "../api-keys"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"

export const metadata: Metadata = {
  title: "Workspace settings",
}

export default async function WorkspaceSettingsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title="Workspace settings"
          description="Workspace access, automation, and connected services."
        />
        <NoWorkspaceState
          icon={Settings}
          description="Create a workspace during onboarding to manage workspace settings."
        />
      </div>
    )
  }

  const [workspace, integrationCount, unreadNotifications, enabledSchedules, membership] =
    await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          name: true,
          plan: true,
          retentionDays: true,
          _count: {
            select: {
              members: true,
            },
          },
        },
      }),
      prisma.integration.count({ where: { workspaceId, deletedAt: null } }),
      prisma.notification.count({
        where: { workspaceId, status: { not: "read" }, deletedAt: null },
      }),
      prisma.schedule.count({ where: { workspaceId, enabled: true, deletedAt: null } }),
      prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: session.userId } },
        select: { role: true, status: true },
      }),
    ])

  const canManageApiKeys =
    membership?.status === "active" && ["OWNER", "ADMIN"].includes(membership.role)

  if (!workspace) return null

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Workspace settings"
        description="Workspace access, automation, and connected services."
      />

      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-muted-foreground text-xs font-medium uppercase">Workspace</p>
              <p className="mt-1 truncate text-lg font-semibold">{workspace.name}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs font-medium uppercase">Plan</p>
              <p className="mt-1 truncate text-lg font-semibold">{workspace.plan}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs font-medium uppercase">Retention</p>
              <p className="mt-1 truncate text-lg font-semibold">{workspace.retentionDays} days</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <ApiKeysSection workspaceId={workspaceId} canManage={canManageApiKeys} />

      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle as="h2">Open beta</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm leading-6">
            Registration is open while we validate the production service. Scan results are scoped
            evidence, not a security guarantee.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SettingsLink
          href="/dashboard/team"
          icon={Users}
          title="Team"
          description={`${workspace._count.members} member${workspace._count.members === 1 ? "" : "s"}`}
        />
        <SettingsLink
          href="/dashboard/connections"
          icon={Plug}
          title="Connections"
          description={`${integrationCount} connected`}
        />
        <SettingsLink
          href="/dashboard/notifications"
          icon={Bell}
          title="Notifications"
          description={`${unreadNotifications} unread`}
        />
        <SettingsLink
          href="/dashboard/scans?tab=monitoring"
          icon={CalendarClock}
          title="Schedules"
          description={`${enabledSchedules} active`}
        />
      </div>
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
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
}) {
  return (
    <Card className="hover:border-primary/50 hover:shadow-card-hover transition-[border-color,box-shadow]">
      <CardContent className="p-5">
        <Icon className="text-primary mb-4 h-5 w-5" aria-hidden="true" />
        <h2 className="font-semibold tracking-tight">{title}</h2>
        <p className="text-muted-foreground mt-1 min-h-10 text-sm">{description}</p>
        <Link
          className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-4 w-full" })}
          href={href}
        >
          Open
        </Link>
      </CardContent>
    </Card>
  )
}
