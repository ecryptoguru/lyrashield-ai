export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading page">
      <div className="mb-6 space-y-3">
        <div className="bg-muted h-8 w-48 max-w-full animate-pulse" />
        <div className="bg-muted h-4 w-96 max-w-full animate-pulse" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="bg-card border-border animate-pulse border p-5">
            {/* Badge row + title + summary line — mirrors a fix proposal card */}
            <div className="flex gap-2">
              <div className="bg-muted h-5 w-20" />
              <div className="bg-muted h-5 w-16" />
            </div>
            <div className="bg-muted mt-3 h-5 w-72 max-w-full" />
            <div className="bg-muted mt-2 h-4 w-96 max-w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
