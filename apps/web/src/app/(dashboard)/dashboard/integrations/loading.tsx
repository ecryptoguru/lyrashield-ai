import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading integrations">
      <h1 className="sr-only">Loading integrations</h1>
      <div className="mb-6 space-y-3">
        <Skeleton className="bg-muted h-8 w-40 max-w-full rounded-none" />
        <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
      </div>
      <div className="space-y-6">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="bg-card border-border h-44 rounded-lg border" />
        ))}
      </div>
    </div>
  )
}
