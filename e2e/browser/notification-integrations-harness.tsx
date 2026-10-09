import { useState } from "react"
import { Button } from "@lyrashield/ui"
import { NotificationIntegrations } from "../../apps/web/src/app/(dashboard)/dashboard/settings/workspace/notification-integrations"

export default function NotificationIntegrationsHarness() {
  const [workspaceId, setWorkspaceId] = useState("workspace-test")
  const params = new URLSearchParams(location.search)
  document.documentElement.classList.toggle("dark", params.get("theme") === "dark")
  return (
    <main className="mx-auto min-h-screen w-full min-w-0 max-w-4xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold">Workspace settings</h1>
      <Button onClick={() => setWorkspaceId("workspace-next")}>Switch workspace</Button>
      <NotificationIntegrations workspaceId={workspaceId} canManage={!params.has("read-only")} />
    </main>
  )
}
