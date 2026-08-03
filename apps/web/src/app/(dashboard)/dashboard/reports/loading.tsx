import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading page">
      <h1 className="sr-only">Loading page</h1>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-3">
          <Skeleton className="bg-muted h-8 w-40 max-w-full rounded-none" />
          <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
        </div>
        <Skeleton className="bg-muted h-10 w-40 self-start rounded-none sm:self-auto" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="bg-card border-border h-28 rounded-lg border" />
        ))}
      </div>
    </div>
  )
}
