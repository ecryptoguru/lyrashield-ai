import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell label="Loading platform admin" className="flex flex-col gap-6">
      <LoadingShellHeader />
      <Skeleton className="bg-card border-border h-16 rounded-none border" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <Skeleton key={item} className="bg-card border-border h-36 rounded-none border" />
        ))}
      </div>
    </LoadingShell>
  )
}
