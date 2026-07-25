export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading page">
      <div className="space-y-3">
        <div className="bg-muted h-3 w-28 animate-pulse" />
        <div className="bg-muted h-9 w-72 max-w-full animate-pulse" />
        <div className="bg-muted h-4 w-96 max-w-full animate-pulse" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="bg-card border-border h-28 animate-pulse border p-4">
            <div className="bg-muted h-5 w-64 max-w-full" />
            <div className="bg-muted mt-2 h-4 w-80 max-w-full" />
            {/* Badge row — reserved so cards don't grow when real content lands */}
            <div className="mt-3 flex gap-2">
              <div className="bg-muted h-5 w-20" />
              <div className="bg-muted h-5 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
