import Link from "next/link"
import { EmptyState, buttonVariants } from "@lyrashield/ui"
import { Plus, type LucideIcon } from "lucide-react"

/**
 * The single "you have no workspace yet" state.
 *
 * Ten dashboard pages previously each rendered their own copy of this with no action,
 * parking the user on a page with no route forward, while two other pages rendered the
 * same state correctly with a link to onboarding. Consolidated here so the way out
 * cannot drift or go missing again.
 */
export function NoWorkspaceState({
  icon,
  description,
}: {
  icon: LucideIcon
  /** What the user is missing out on, in their words. */
  description: string
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        className="w-full"
        icon={icon}
        title="No workspace yet"
        description={description}
        action={
          <Link href="/onboarding" className={buttonVariants()}>
            <Plus className="size-4" aria-hidden="true" />
            Create workspace
          </Link>
        }
      />
    </div>
  )
}
