import { Loader2 } from "lucide-react"
import { cn } from "./utils"

interface SpinnerProps {
  className?: string
}

export function Spinner({ className }: SpinnerProps) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} aria-hidden="true" />
}
