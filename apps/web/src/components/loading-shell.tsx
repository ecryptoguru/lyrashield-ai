import { Skeleton } from "@/components/ui/skeleton"

/**
 * Shared dashboard loading shell: one polite live-region with an sr-only
 * heading that mirrors the region label, so route loading states stay
 * consistent and screen-reader friendly. Route-specific skeleton layouts are
 * passed as children.
 *
 * `label` defaults to the shared "Loading page" wording; routes that announce
 * a more specific destination pass their own (e.g. "Loading billing").
 * `className` is the wrapper layout class (usually "space-y-6"); when omitted
 * no class attribute is rendered, matching routes whose status region is
 * unstyled.
 */
export function LoadingShell({
  label = "Loading page",
  className,
  children,
}: {
  label?: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div className={className} role="status" aria-live="polite" aria-busy="true" aria-label={label}>
      <h1 className="sr-only">{label}</h1>
      {children}
    </div>
  )
}

/**
 * The fixed header skeletons the dashboard loading routes share.
 *
 * - `detail`: eyebrow row, wide title, subtitle — used on index/detail routes.
 * - `title`: shorter title plus subtitle — used on card-grid and settings
 *   routes, and inside headers that pair it with an action placeholder.
 */
export function LoadingShellHeader({
  variant = "detail",
  className = "space-y-3",
}: {
  variant?: "detail" | "title"
  className?: string
}) {
  return (
    <div className={className}>
      {variant === "detail" ? (
        <>
          <Skeleton className="bg-muted h-3 w-28 rounded-none" />
          <Skeleton className="bg-muted h-9 w-72 max-w-full rounded-none" />
          <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
        </>
      ) : (
        <>
          <Skeleton className="bg-muted h-8 w-40 max-w-full rounded-none" />
          <Skeleton className="bg-muted h-4 w-96 max-w-full rounded-none" />
        </>
      )}
    </div>
  )
}
