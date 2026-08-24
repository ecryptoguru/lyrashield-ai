import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading coding agents">
      <h1 className="sr-only">Loading coding agents</h1>
      <div className="mb-6 space-y-3">
        <Skeleton className="bg-muted h-8 w-48 max-w-full rounded-none" />
        <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <Skeleton key={item} className="bg-card border-border h-40 rounded-lg border" />
        ))}
      </div>
    </div>
  )
}
