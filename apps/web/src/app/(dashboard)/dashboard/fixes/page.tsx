import { Wrench } from "lucide-react"
import { EmptyState } from "@lyrashield/ui"

export default function FixesPage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Fixes</h1>
      <EmptyState
        icon={Wrench}
        title="Fixes coming soon"
        description="Automated fix PRs are not yet built. Once scans detect findings, you'll be able to generate and review fix PRs from this page."
      />
    </div>
  )
}
