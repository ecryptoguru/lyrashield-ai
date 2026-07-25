export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading scan">
      {/* Back link + title bar */}
      <div className="mb-6 space-y-3">
        <div className="bg-muted h-4 w-28 animate-pulse" />
        <div className="bg-muted h-8 w-72 max-w-full animate-pulse" />
        <div className="bg-muted h-4 w-56 max-w-full animate-pulse" />
      </div>
      {/* Stat grid — mirrors the 5-column terminal layout */}
      <div className="bg-border mb-6 grid gap-px border sm:grid-cols-2 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((item) => (
          <div key={item} className="bg-card h-24 animate-pulse p-4">
            <div className="bg-muted h-4 w-24 max-w-full" />
            <div className="bg-muted mt-2 h-6 w-14 max-w-full" />
          </div>
        ))}
      </div>
      {/* Content block (target / next-step / findings) */}
      <div className="space-y-6">
        <div className="bg-card border-border h-20 animate-pulse border" />
        <div className="bg-card border-border h-48 animate-pulse border" />
      </div>
    </div>
  )
}
