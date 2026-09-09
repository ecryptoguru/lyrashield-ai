import type { Metadata } from "next"
import { Building2, Settings } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@lyrashield/ui"
import { prisma } from "@lyrashield/db"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { DeleteAccount } from "./delete-account"
import { ConnectedAccounts } from "./connected-accounts"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { TwoFactorSecurity } from "./two-factor-security"
import { WorkspaceSettingsLink } from "./workspace-settings-link"

export const metadata: Metadata = {
  title: "Settings",
}

export default async function SettingsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const [workspaceId, accountSecurity] = await Promise.all([
    getCachedWorkspaceId(session.userId),
    prisma.user.findUnique({
      where: { id: session.userId },
      select: { twoFactorEnabled: true },
    }),
  ])
  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title="Personal settings"
          description="Your account security and connected sign-in accounts."
        />
        <NoWorkspaceState
          icon={Settings}
          description="Create a workspace during onboarding to manage workspace settings."
        />
        <div className="mt-6">
          <TwoFactorSecurity enabled={Boolean(accountSecurity?.twoFactorEnabled)} />
        </div>
        <div className="mt-6">
          <DeleteAccount />
        </div>
      </div>
    )
  }

  const [workspace, membership] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    }),
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.userId } },
      select: { role: true, status: true },
    }),
  ])

  if (!workspace) return null

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Personal settings"
        description="Your account security and connected sign-in accounts."
      />

      <ConnectedAccounts />

      <TwoFactorSecurity enabled={Boolean(accountSecurity?.twoFactorEnabled)} />

      <WorkspaceSettingsLink
        workspaceName={workspace.name}
        canOpenWorkspaceSettings={membership?.status === "active"}
      />

      <DeleteAccount />
    </div>
  )
}

function WorkspaceSettingsLink({
  workspaceName,
  canOpenWorkspaceSettings,
}: {
  workspaceName: string
  canOpenWorkspaceSettings: boolean
}) {
  if (!canOpenWorkspaceSettings) return null
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <Building2 className="text-primary h-5 w-5" aria-hidden="true" />
          Workspace settings
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm leading-6">
          Workspace access, automation, and connected services for{" "}
          <span className="text-foreground font-medium">{workspaceName}</span> live in workspace
          settings.
        </p>
        <a
          className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-4" })}
          href="/dashboard/settings/workspace"
        >
          Open workspace settings
        </a>
      </CardContent>
    </Card>
  )
}
