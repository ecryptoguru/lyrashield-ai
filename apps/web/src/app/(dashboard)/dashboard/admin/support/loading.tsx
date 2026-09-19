import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell label="Loading support inbox" className="space-y-6">
      <LoadingShellHeader />
      <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-3">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="bg-card border-border h-20 rounded-lg border" />
          ))}
        </div>
        <Skeleton className="bg-card border-border h-96 rounded-lg border" />
      </div>
    </LoadingShell>
  )
}
