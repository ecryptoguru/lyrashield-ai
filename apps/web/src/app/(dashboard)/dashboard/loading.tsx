import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell className="space-y-6">
      <LoadingShellHeader />
      <div className="bg-border grid gap-px border sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <Skeleton key={item} className="bg-card h-24 rounded-none" />
        ))}
      </div>
      <Skeleton className="bg-muted h-64 w-full rounded-none" />
    </LoadingShell>
  )
}
