import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-live="polite" aria-busy="true" aria-label="Loading page">
      <h1 className="sr-only">Loading page</h1>
      <div className="space-y-3">
        <Skeleton className="bg-muted h-3 w-28 rounded-none" />
        <Skeleton className="bg-muted h-9 w-72 max-w-full rounded-none" />
        <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
      </div>
      <Skeleton className="bg-muted border-border h-40 rounded-none border-l-2" />
      <div className="bg-border grid gap-px border sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <Skeleton key={item} className="bg-card h-28 rounded-none" />
        ))}
      </div>
    </div>
  )
}
