import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell label="Loading integrations">
      <LoadingShellHeader variant="title" className="mb-6 space-y-3" />
      <div className="space-y-6">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="bg-card border-border h-44 rounded-lg border" />
        ))}
      </div>
    </LoadingShell>
  )
}
