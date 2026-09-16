import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell label="Loading billing">
      <LoadingShellHeader variant="title" className="mb-6 space-y-3" />
      <div className="space-y-6">
        <Skeleton className="bg-card border-border h-44 rounded-lg border" />
        <Skeleton className="bg-card border-border h-40 rounded-lg border" />
        <Skeleton className="bg-card border-border h-36 rounded-lg border" />
      </div>
    </LoadingShell>
  )
}
