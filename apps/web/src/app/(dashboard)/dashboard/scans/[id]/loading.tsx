import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading scan">
      <div className="mb-6 space-y-3">
        <Skeleton className="bg-muted h-4 w-28 rounded-none" />
        <Skeleton className="bg-muted h-8 w-72 max-w-full rounded-none" />
        <Skeleton className="bg-muted h-4 w-56 max-w-full rounded-none" />
      </div>
      <div className="bg-border mb-6 grid gap-px border sm:grid-cols-2 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((item) => (
          <div key={item} className="bg-card h-24 p-4">
            <Skeleton className="bg-muted h-4 w-24 max-w-full rounded-none" />
            <Skeleton className="bg-muted mt-2 h-6 w-14 max-w-full rounded-none" />
          </div>
        ))}
      </div>
      <div className="space-y-6">
        <Skeleton className="bg-card border-border h-20 rounded-none border" />
        <Skeleton className="bg-card border-border h-48 rounded-none border" />
      </div>
    </div>
  )
}
