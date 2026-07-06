import { Settings } from "lucide-react"
import { EmptyState } from "@lyrashield/ui"

export default function SettingsPage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Settings</h1>
      <EmptyState
        icon={Settings}
        title="Settings coming soon"
        description="Workspace settings, billing, and API keys will be configurable from this page."
      />
    </div>
  )
}
