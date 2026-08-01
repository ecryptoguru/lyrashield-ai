import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="min-w-0 space-y-6" aria-busy="true" aria-label="Loading page">
      <div className="space-y-3">
        <Skeleton className="bg-muted h-8 w-40 max-w-full rounded-none" />
        <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
      </div>
      <Skeleton className="bg-card border-border h-24 rounded-none border" />
      <Skeleton className="bg-card border-border h-40 rounded-none border" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <Skeleton key={item} className="bg-card border-border h-24 rounded-none border" />
        ))}
      </div>
    </div>
  )
}
