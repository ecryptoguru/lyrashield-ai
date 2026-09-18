import type { Metadata } from "next"
import { NotFoundCard } from "@/app/not-found"

/**
 * Not-found boundary for the console.
 *
 * Two reasons this exists instead of falling through to the root boundary:
 * 1. `(dashboard)/layout.tsx` already renders `<main id="main-content">`, so the
 *    root card (which owns a `<main>`) would nest a second main landmark.
 * 2. The title is resolved through Next's not-found convention, which is what
 *    replaces the dead resource's own title ("Target | LyraShield AI") on a
 *    link that no longer resolves.
 */
export const metadata: Metadata = {
  title: "Not found",
  robots: { index: false, follow: false },
}

export default function DashboardNotFound() {
  return <NotFoundCard />
}
