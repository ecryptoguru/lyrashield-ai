import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading billing">
      <h1 className="sr-only">Loading billing</h1>
      <div className="mb-6 space-y-3">
        <Skeleton className="bg-muted h-8 w-40 max-w-full rounded-none" />
        <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
      </div>
      <div className="space-y-6">
        <Skeleton className="bg-card border-border h-44 rounded-lg border" />
        <Skeleton className="bg-card border-border h-40 rounded-lg border" />
        <Skeleton className="bg-card border-border h-36 rounded-lg border" />
      </div>
    </div>
  )
}
