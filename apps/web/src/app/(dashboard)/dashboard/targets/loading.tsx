import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading page">
      <div className="space-y-3">
        <Skeleton className="bg-muted h-3 w-28 rounded-none" />
        <Skeleton className="bg-muted h-9 w-72 max-w-full rounded-none" />
        <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
      </div>
      <div className="bg-border grid gap-px border sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="bg-card h-28 rounded-none" />
        ))}
      </div>
    </div>
  )
}
