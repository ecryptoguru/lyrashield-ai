import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell className="space-y-6">
      <LoadingShellHeader />
      <div className="bg-border grid gap-px border sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="bg-card h-28 rounded-none" />
        ))}
      </div>
    </LoadingShell>
  )
}
