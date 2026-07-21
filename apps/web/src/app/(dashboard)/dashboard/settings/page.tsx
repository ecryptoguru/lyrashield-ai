import Link from "next/link"
import type { ComponentType, SVGProps } from "react"
import { Bell, CalendarClock, Plug, Settings, Users } from "lucide-react"
import { Card, CardContent, EmptyState, buttonVariants } from "@lyrashield/ui"
import { prisma } from "@lyrashield/db"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { DeleteAccount } from "./delete-account"
import { ConnectedAccounts } from "./connected-accounts"

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
    prisma.notification.count({ where: { workspaceId, status: { not: "read" }, deletedAt: null } }),
    prisma.schedule.count({ where: { workspaceId, enabled: true, deletedAt: null } }),
  ])

  if (!workspace) return null

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Workspace access, automation, and connected services.
          </p>
        </div>
      </div>

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

      <ConnectedAccounts />

      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle>Production beta</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm leading-6">
            Access is limited while we validate the production service. Scan results are scoped
            evidence, not a security guarantee. For beta support, reply to your invitation email.
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
          href="/dashboard/integrations"
          icon={Plug}
          title="Integrations"
          description={`${integrationCount} connected`}
        />
        <SettingsLink
          href="/dashboard/notifications"
          icon={Bell}
          title="Notifications"
          description={`${unreadNotifications} unread`}
        />
        <SettingsLink
          href="/dashboard/schedules"
          icon={CalendarClock}
          title="Schedules"
          description={`${enabledSchedules} active`}
        />
      </div>

      <DeleteAccount />
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
