import { Radar } from "lucide-react"
import { EmptyState } from "@lyrashield/ui"

export default function ScansPage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Scans</h1>
      <EmptyState
        icon={Radar}
        title="Scans coming soon"
        description="The scan engine is not yet built. You'll be able to launch and monitor security scans from this page."
      />
    </div>
  )
}
