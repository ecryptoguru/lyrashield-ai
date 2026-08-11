import { cn } from "@lyrashield/ui"
import { type LucideIcon } from "lucide-react"

export function PageHeader({
  title,
  description,
  action,
  icon: Icon,
  iconClassName,
  children,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  icon?: LucideIcon
  iconClassName?: string
  children?: React.ReactNode
}) {
  return (
    <div className="mb-6 space-y-4 sm:mb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-3">
          {Icon ? (
            <Icon
              className={cn("text-primary h-6 w-6 shrink-0", iconClassName)}
              aria-hidden="true"
            />
          ) : null}
          <div>
            <h1 className="text-balance text-2xl font-bold tracking-tight">{title}</h1>
            {description ? (
              <p className="text-muted-foreground mt-1 max-w-2xl text-pretty text-sm leading-relaxed">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {action ? (
          <div className="flex flex-wrap gap-2 self-start sm:self-auto">{action}</div>
        ) : null}
      </div>
      {children}
    </div>
  )
}
