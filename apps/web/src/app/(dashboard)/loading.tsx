import { Loader2 } from "lucide-react"

export default function Loading() {
  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-3" aria-busy="true">
      <Loader2 className="text-primary h-8 w-8 animate-spin" aria-hidden="true" />
      <p className="text-muted-foreground text-sm">Loading...</p>
    </div>
  )
}
