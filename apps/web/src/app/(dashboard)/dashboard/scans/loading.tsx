import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell className="space-y-6">
      <LoadingShellHeader />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="bg-card border-border h-28 rounded-lg border p-4">
            <Skeleton className="bg-muted h-5 w-64 max-w-full rounded-none" />
            <Skeleton className="bg-muted mt-2 h-4 w-80 max-w-full rounded-none" />
            <div className="mt-3 flex gap-2">
              <Skeleton className="bg-muted h-5 w-20 rounded-none" />
              <Skeleton className="bg-muted h-5 w-16 rounded-none" />
            </div>
          </div>
        ))}
      </div>
    </LoadingShell>
  )
}
