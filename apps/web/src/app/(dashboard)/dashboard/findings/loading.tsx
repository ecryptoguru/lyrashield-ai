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
      <div className="space-y-3">
        {[0, 1, 2, 3, 4].map((item) => (
          <div key={item} className="bg-card border-border h-24 rounded-lg border p-4">
            <Skeleton className="bg-muted h-5 w-72 max-w-full rounded-none" />
            <div className="mt-3 flex gap-2">
              <Skeleton className="bg-muted h-5 w-16 rounded-none" />
              <Skeleton className="bg-muted h-5 w-24 rounded-none" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
