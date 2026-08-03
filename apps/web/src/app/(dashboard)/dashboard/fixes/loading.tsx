import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading page">
      <h1 className="sr-only">Loading page</h1>
      <div className="mb-6 space-y-3">
        <Skeleton className="bg-muted h-8 w-48 max-w-full rounded-none" />
        <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="bg-card border-border border p-5">
            <div className="flex gap-2">
              <Skeleton className="bg-muted h-5 w-20 rounded-none" />
              <Skeleton className="bg-muted h-5 w-16 rounded-none" />
            </div>
            <Skeleton className="bg-muted mt-3 h-5 w-72 max-w-full rounded-none" />
            <Skeleton className="bg-muted mt-2 h-4 w-96 max-w-full rounded-none" />
          </div>
        ))}
      </div>
    </div>
  )
}
