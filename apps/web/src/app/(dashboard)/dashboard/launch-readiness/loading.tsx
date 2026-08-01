import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading page">
      <Skeleton className="bg-muted h-8 w-64 max-w-full rounded-none" />
      <Skeleton className="bg-card border-border h-44 rounded-none border" />
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((item) => (
          <Skeleton key={item} className="bg-card border-border h-40 rounded-none border" />
        ))}
      </div>
      <Skeleton className="bg-card border-border h-40 rounded-none border" />
    </div>
  )
}
