import { cn } from "./utils"

interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("rounded-lg border border-dashed p-12 text-center", className)}>
      {Icon && <Icon className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden="true" />}
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      {description && <p className="mb-4 text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  )
}
