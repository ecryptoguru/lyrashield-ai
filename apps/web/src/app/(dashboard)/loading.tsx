export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading page">
      <div className="space-y-3">
        <div className="bg-muted h-3 w-28 animate-pulse" />
        <div className="bg-muted h-9 w-72 max-w-full animate-pulse" />
        <div className="bg-muted h-4 w-96 max-w-full animate-pulse" />
      </div>
      <div className="bg-muted border-border h-40 animate-pulse border-l-2" />
      <div className="bg-border grid gap-px border sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="bg-card h-28 animate-pulse" />
        ))}
      </div>
    </div>
  )
}
