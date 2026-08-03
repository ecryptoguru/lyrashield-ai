import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading page"
    >
      <h1 className="sr-only">Loading page</h1>
      <div className="space-y-3">
        <Skeleton className="bg-muted h-8 w-40 max-w-full rounded-none" />
        <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
      </div>
      <Skeleton className="bg-card border-border h-40 rounded-none border" />
    </div>
  )
}
