export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading page">
      <div className="bg-muted h-8 w-64 max-w-full animate-pulse" />
      {/* Verdict card with score gauge */}
      <div className="bg-card border-border h-44 animate-pulse border" />
      {/* Conditions + recommendations */}
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((item) => (
          <div key={item} className="bg-card border-border h-40 animate-pulse border" />
        ))}
      </div>
      {/* Severity breakdown */}
      <div className="bg-card border-border h-40 animate-pulse border" />
    </div>
  )
}
