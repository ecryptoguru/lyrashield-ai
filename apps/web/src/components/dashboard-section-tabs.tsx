import Link from "next/link"
import { cn } from "@lyrashield/ui"

export interface SectionTab {
  /** Tab identifier, also used as the `tab` query value. */
  value: string
  label: string
  /** Canonical URL including the `?tab=` query. */
  href: string
}

/**
 * Shared, URL-driven section header for consolidated dashboard areas
 * (Trust Runs, Issues). The active tab is determined by the server-rendered
 * URL, not client state, so each view is bookmarkable, deep-linkable, and
 * loads only its own content.
 *
 * The header renders the page heading, an optional description, an optional
 * action slot (e.g. "New run"), and an accessible horizontal tab list that
 * uses real anchor links with `aria-current="page"`.
 */
export function DashboardSectionTabs({
  title,
  description,
  tabs,
  activeTab,
  action,
}: {
  title: string
  description?: string
  tabs: SectionTab[]
  activeTab: string
  action?: React.ReactNode
}) {
  return (
    <div className="mb-6 space-y-4 sm:mb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-balance text-2xl font-bold tracking-tight">{title}</h1>
          {description ? (
            <p className="text-muted-foreground mt-1 max-w-2xl text-pretty text-sm leading-relaxed">
              {description}
            </p>
          ) : null}
        </div>
        {action ? (
          <div className="flex flex-wrap gap-2 self-start sm:self-auto">{action}</div>
        ) : null}
      </div>

      <nav aria-label={`${title} sections`}>
        <ul className="flex items-center gap-1 overflow-x-auto border-b pb-px">
          {tabs.map((tab) => {
            const active = tab.value === activeTab
            return (
              <li key={tab.value}>
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative inline-flex min-h-11 items-center border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-[border-color,color] duration-(--duration-fast) ease-out",
                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                    active
                      ? "border-primary text-primary"
                      : "text-muted-foreground hover:border-foreground/30 hover:text-foreground border-transparent"
                  )}
                >
                  {tab.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
