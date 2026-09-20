import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell label="Loading scan" className="space-y-6">
      <LoadingShellHeader />
      <Skeleton className="bg-card border-border h-48 rounded-lg border" />
      <Skeleton className="bg-card border-border h-40 rounded-lg border" />
      <Skeleton className="bg-card border-border h-56 rounded-lg border" />
    </LoadingShell>
  )
}
