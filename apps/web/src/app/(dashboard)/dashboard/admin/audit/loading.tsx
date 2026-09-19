import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell label="Loading audit log" className="space-y-6">
      <LoadingShellHeader />
      <div className="space-y-3">
        {[0, 1, 2, 3, 4].map((item) => (
          <Skeleton key={item} className="bg-card border-border h-14 rounded-lg border" />
        ))}
      </div>
    </LoadingShell>
  )
}
