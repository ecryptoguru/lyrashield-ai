import { LoadingShell, LoadingShellHeader } from "@/components/loading-shell"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <LoadingShell className="space-y-6">
      <LoadingShellHeader variant="title" />
      <Skeleton className="bg-card border-border h-40 rounded-none border" />
    </LoadingShell>
  )
}
