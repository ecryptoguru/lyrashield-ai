"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Plus, Crosshair, Bug, Globe, GitBranch, Trash2 } from "lucide-react"
import { Button, Badge, EmptyState, cn } from "@lyrashield/ui"
import { InlineConfirm } from "@/components/ui/inline-confirm"
import { TARGET_PLURAL, TARGET_SINGULAR, RUN_PLURAL, ISSUE_PLURAL } from "@/lib/terminology"
import { getTargetTypeLabel } from "@/lib/enum-labels"
import { humanizeToken } from "@/lib/labels"
import type { Target } from "./targets-model"

/**
 * True while a horizontal scroll container still has content off its right
 * edge. Drives the scroll affordance so the cue appears only when something is
 * actually hidden (and disappears once the user reaches the end), rather than
 * permanently greying the edge of a table that already fits.
 */
function useHorizontalOverflow<T extends HTMLElement>() {
  const scrollRef = useRef<T | null>(null)
  const [overflows, setOverflows] = useState(false)

  const measureOverflow = useCallback((element: HTMLElement | null) => {
    if (!element) return
    // 1px of slack absorbs sub-pixel rounding so a table that fits exactly
    // never shows a permanent fade.
    setOverflows(element.scrollLeft + element.clientWidth < element.scrollWidth - 1)
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    measureOverflow(element)
    const observer = new ResizeObserver(() => measureOverflow(element))
    observer.observe(element)
    // The table's own width changes when the breakpoint swaps columns in or out.
    const table = element.firstElementChild
    if (table) observer.observe(table)
    return () => observer.disconnect()
  }, [measureOverflow])

  return { scrollRef, overflows, measureOverflow }
}

export function TargetsEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      icon={Crosshair}
      title={`No ${TARGET_PLURAL.toLowerCase()} yet`}
      description="Add a repository or URL target to start scanning."
      action={
        <Button onClick={onAdd}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add {TARGET_SINGULAR.toLowerCase()}
        </Button>
      }
    />
  )
}

export function TargetsTable({
  targets,
  onDelete,
}: {
  targets: Target[]
  onDelete: (target: Target) => void
}) {
  const { scrollRef, overflows, measureOverflow } = useHorizontalOverflow<HTMLDivElement>()
  return (
    // UF-28: the fade is positioned against this wrapper, not the scroll
    // container, so it never joins the scrollable content. The container keeps
    // its own overflow-x-auto / tabindex / aria-label contract.
    <div className="relative w-full min-w-0 max-w-full">
      <div
        ref={scrollRef}
        onScroll={(event) => measureOverflow(event.currentTarget)}
        className="w-full min-w-0 max-w-full overflow-x-auto rounded-xl border shadow-sm [contain:paint]"
        tabIndex={0}
        aria-label="Targets list"
      >
        {/* UF-28: the fixed 640px floor used to apply at every width, so a 359px
            phone rendered 281px of table outside the card. It now only applies
            from `sm`, where the columns it protects are actually shown. */}
        <table className="w-full min-w-0 text-sm sm:min-w-[40rem]">
          <thead className="bg-muted/30 border-b">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-semibold">
                Name
              </th>
              <th scope="col" className="px-4 py-3 text-left font-semibold">
                Type
              </th>
              {/* UF-28: domain verification is self-attested metadata; it is the
                  column that yields below `sm` so the meaningful Status stays
                  visible at 393px. It keeps its own cell at `sm`+ so the
                  screen-reader fallback below is never the only source. */}
              <th scope="col" className="hidden px-4 py-3 text-left font-semibold sm:table-cell">
                Domain verification
              </th>
              <th scope="col" className="hidden px-4 py-3 text-left font-semibold lg:table-cell">
                {RUN_PLURAL}
              </th>
              <th scope="col" className="hidden px-4 py-3 text-left font-semibold lg:table-cell">
                {ISSUE_PLURAL}
              </th>
              <th scope="col" className="px-4 py-3 text-left font-semibold">
                Status
              </th>
              <th scope="col" className="hidden px-4 py-3 text-left font-semibold sm:table-cell">
                <span className="sr-only">View</span>
              </th>
              <th scope="col" className="hidden px-4 py-3 text-left font-semibold sm:table-cell">
                <span className="sr-only">Delete</span>
              </th>
              <th scope="col" className="sr-only">
                <span className="sr-only">
                  {RUN_PLURAL} and {ISSUE_PLURAL} summary
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.id} className="hover:bg-muted/30 border-b last:border-0">
                {/* UF-28: `w-full max-w-0` is what makes `truncate` actually
                    truncate. Without it the nowrap name sets the column's
                    min-content width, so one long target name pushed the whole
                    table past its container at every breakpoint. The name
                    column now absorbs the leftover width and long values
                    ellipsize instead of forcing a horizontal scroll. */}
                <td className="w-full max-w-0 overflow-hidden px-4 py-3">
                  <Link
                    href={`/dashboard/targets/${t.id}`}
                    className="block truncate font-medium hover:underline"
                    aria-label={`View ${TARGET_SINGULAR.toLowerCase()} ${t.name}`}
                  >
                    {t.name}
                  </Link>
                  {t.repoFullName && (
                    <div className="text-muted-foreground truncate text-xs">{t.repoFullName}</div>
                  )}
                  {t.url && <div className="text-muted-foreground truncate text-xs">{t.url}</div>}
                </td>
                <td className="px-4 py-3">
                  <Badge>
                    {t.type === "REPO" ? (
                      <GitBranch className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <Globe className="h-3 w-3" aria-hidden="true" />
                    )}
                    {getTargetTypeLabel(t.type)}
                  </Badge>
                </td>
                <td className="hidden px-4 py-3 sm:table-cell">
                  <Badge
                    variant={
                      t.domainVerificationStatus?.startsWith("Verified until") ? "success" : "muted"
                    }
                  >
                    {t.domainVerificationStatus ??
                      (t.type === "WEB_APP" || t.type === "API"
                        ? "Not verified"
                        : "Not applicable")}
                  </Badge>
                </td>
                <td className="hidden px-4 py-3 lg:table-cell">{t.scanCount}</td>
                <td className="hidden px-4 py-3 lg:table-cell">
                  {t.findingCount > 0 ? (
                    <span className="text-destructive flex items-center gap-1">
                      <Bug className="h-3 w-3" aria-hidden="true" />
                      {t.findingCount}
                    </span>
                  ) : (
                    "0"
                  )}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={t.status === "active" ? "success" : "muted"}>
                    {humanizeToken(t.status)}
                  </Badge>
                </td>
                <td className="hidden px-4 py-3 sm:table-cell">
                  <Link
                    href={`/dashboard/targets/${t.id}`}
                    className="text-primary text-xs font-medium hover:underline"
                    aria-label={`View ${TARGET_SINGULAR.toLowerCase()} ${t.name}`}
                  >
                    View
                  </Link>
                </td>
                <td className="hidden px-4 py-3 sm:table-cell">
                  <InlineConfirm
                    triggerIcon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                    aria-label={`Delete ${TARGET_SINGULAR.toLowerCase()} ${t.name}`}
                    message={`Delete ${t.name}? Scans, findings, verdicts and reports stay in the workspace.`}
                    confirmLabel="Delete"
                    onConfirm={() => onDelete(t)}
                  />
                </td>
                {/* Mobile/AT fallback: Runs and Issues are hidden below lg, so
                    those counts are otherwise unreachable on small screens.
                    Status is visible at every width since UF-28, so it is not
                    repeated here. */}
                <td className="sr-only">
                  <span className="sr-only">{`${t.scanCount} ${RUN_PLURAL.toLowerCase()}, ${t.findingCount} ${ISSUE_PLURAL.toLowerCase()}`}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Scroll affordance: a soft edge fade over the right edge of the card
          while — and only while — the table still has content to the right.
          Hidden from AT: the container is already focusable and labelled. */}
      <div
        aria-hidden="true"
        data-testid="targets-table-scroll-fade"
        className={cn(
          "from-background via-background/70 pointer-events-none absolute inset-y-px right-px w-8 rounded-r-xl bg-gradient-to-l to-transparent transition-opacity duration-(--duration-fast)",
          overflows ? "opacity-100" : "opacity-0"
        )}
      />
    </div>
  )
}
