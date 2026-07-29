export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading page">
      {/* Title + subtitle with the Generate Report action on the right */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-3">
          <div className="bg-muted h-8 w-40 max-w-full animate-pulse" />
          <div className="bg-muted h-4 w-96 max-w-full animate-pulse" />
        </div>
        <div className="bg-muted h-10 w-40 animate-pulse self-start sm:self-auto" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="bg-card border-border h-28 animate-pulse rounded-lg border" />
        ))}
      </div>
    </div>
  )
}
