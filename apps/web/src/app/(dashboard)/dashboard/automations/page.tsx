import Link from "next/link"
import { CalendarClock } from "lucide-react"
import { EmptyState, buttonVariants } from "@lyrashield/ui"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { AUTOMATION_PLURAL } from "@/lib/terminology"
import { NoWorkspaceState } from "@/components/no-workspace-state"

export default async function AutomationsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">{AUTOMATION_PLURAL}</h1>
        <NoWorkspaceState
          icon={CalendarClock}
          description={`Create a workspace during onboarding to manage ${AUTOMATION_PLURAL.toLowerCase()}.`}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{AUTOMATION_PLURAL}</h1>
      <EmptyState
        icon={CalendarClock}
        title="No automations yet"
        description="Set up scheduled checks on the Schedules page. Full automation workflows will be available later."
        action={
          <Link
            href="/dashboard/schedules"
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            Go to schedules
          </Link>
        }
      />
    </div>
  )
}
