"use client"

import { type ReactNode } from "react"
import { cn } from "@lyrashield/ui"

export interface ResponsiveListProps {
  children: ReactNode
  className?: string
  /**
   * Number of columns at the medium breakpoint and above.
   * Defaults to one column on mobile, two on md, three on lg.
   */
  columns?: "1" | "2" | "3" | "4"
  /**
   * Render items as a compact card list with large touch targets on mobile.
   */
  compact?: boolean
}

const columnClasses = {
  "1": "grid-cols-1",
  "2": "grid-cols-1 md:grid-cols-2",
  "3": "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
  "4": "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
}

export function ResponsiveList({
  children,
  className,
  columns = "3",
  compact,
}: ResponsiveListProps) {
  return (
    <ul className={cn("grid gap-4", columnClasses[columns], compact && "gap-2", className)}>
      {children}
    </ul>
  )
}

export function ResponsiveListItem({
  children,
  className,
  onClick,
}: {
  children: ReactNode
  className?: string
  onClick?: () => void
}) {
  return (
    <li
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn(
        "bg-card text-card-foreground rounded-xl border p-4 shadow-xs transition-colors",
        onClick &&
          "hover:bg-accent focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none cursor-pointer",
        className
      )}
    >
      {children}
    </li>
  )
}
