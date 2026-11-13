import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell label="Loading release packet">
      <div className="mb-6 space-y-3">
        <Skeleton className="bg-muted h-4 w-24 rounded-none" />
        <Skeleton className="bg-muted h-8 w-64 max-w-full rounded-none" />
      </div>
      <div className="bg-card border-border space-y-4 rounded-lg border p-5 sm:p-6">
        <LoadingShellHeader variant="title" />
        <Skeleton className="bg-muted h-4 w-full rounded-none" />
        <Skeleton className="bg-muted h-4 w-3/4 rounded-none" />
        <Skeleton className="bg-muted h-4 w-1/2 rounded-none" />
        <Skeleton className="bg-muted h-11 w-48 rounded-none" />
      </div>
    </LoadingShell>
  )
}
