import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <LoadingShellHeader variant="title" />
        <Skeleton className="bg-muted h-10 w-40 self-start rounded-none sm:self-auto" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="bg-card border-border h-28 rounded-lg border" />
        ))}
      </div>
    </LoadingShell>
  )
}
