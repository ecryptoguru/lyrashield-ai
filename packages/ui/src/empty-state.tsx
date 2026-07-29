import { cn } from "./utils"

interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>
  title: string
  description?: string
  /**
   * The way forward from this state.
   *
   * Required — and `null` is a valid, deliberate value. An empty state with no route
   * onward is a dead end, and shipping one has been a recurring defect, so the type
   * forces the author to make the call at the call site. Pass `null` only when there is
   * genuinely nothing for the user to do here (for example "no notifications yet"),
   * never because an action simply was not considered.
   */
  action: React.ReactNode | null
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "bg-card/50 flex flex-col items-center rounded-xl border border-dashed p-8 text-center sm:p-12",
        className
      )}
    >
      {Icon && (
        <div className="bg-primary/5 mb-4 flex h-14 w-14 items-center justify-center rounded-xl">
          <Icon className="text-primary h-7 w-7" aria-hidden="true" />
        </div>
      )}
      <h2 className="mb-2 text-lg font-semibold text-balance">{title}</h2>
      {description && (
        <p className="text-muted-foreground mb-6 max-w-sm text-sm text-pretty">{description}</p>
      )}
      {action}
    </div>
  )
}
