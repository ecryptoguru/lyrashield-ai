export default function Loading() {
  return (
    <div className="min-w-0 space-y-6" aria-busy="true" aria-label="Loading page">
      <div className="space-y-3">
        <div className="bg-muted h-8 w-40 max-w-full animate-pulse" />
        <div className="bg-muted h-4 w-96 max-w-full animate-pulse" />
      </div>
      {/* Workspace summary card */}
      <div className="bg-card border-border h-24 animate-pulse border" />
      {/* Connected accounts + API keys sections */}
      <div className="bg-card border-border h-40 animate-pulse border" />
      <div className="bg-card border-border h-40 animate-pulse border" />
      {/* Settings link grid */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="bg-card border-border h-24 animate-pulse border" />
        ))}
      </div>
    </div>
  )
}
