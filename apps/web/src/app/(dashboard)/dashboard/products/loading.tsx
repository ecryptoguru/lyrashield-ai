import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell label="Loading products" className="space-y-6">
      <LoadingShellHeader />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <Skeleton key={item} className="bg-card border-border h-36 rounded-lg border" />
        ))}
      </div>
    </LoadingShell>
  )
}
