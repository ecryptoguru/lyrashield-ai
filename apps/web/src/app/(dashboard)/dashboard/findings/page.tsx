import { Bug } from "lucide-react"
import { EmptyState } from "@lyrashield/ui"

export default function FindingsPage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Findings</h1>
      <EmptyState
        icon={Bug}
        title="Findings coming soon"
        description="The findings pipeline is not yet built. Security vulnerabilities detected by scans will appear here."
      />
    </div>
  )
}
