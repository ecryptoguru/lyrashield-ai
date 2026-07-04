import { FileText } from "lucide-react"
import { EmptyState } from "@lyrashield/ui"

export default function ReportsPage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Reports</h1>
      <EmptyState
        icon={FileText}
        title="Reports coming soon"
        description="Shareable security reports are not yet built. You'll be able to generate and share compliance-ready reports from this page."
      />
    </div>
  )
}
