import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell className="space-y-6">
      <LoadingShellHeader />
      <div className="space-y-2">
        {[0, 1, 2, 3].map((item) => (
          <Skeleton key={item} className="bg-card h-14 w-full rounded-none border" />
        ))}
      </div>
    </LoadingShell>
  )
}
