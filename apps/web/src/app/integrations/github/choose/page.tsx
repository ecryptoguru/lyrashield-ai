import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { verifyInstallState } from "@/lib/github-install-state"
import { matchesGitHubSession } from "@/lib/github-oauth-context"
import { githubReturnPath } from "@/lib/github-install-urls"
import { GitHubInstallationChooser } from "./chooser"

export const metadata: Metadata = {
  title: "Choose GitHub installation",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
}

export default async function GitHubChooserPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>
}) {
  const session = await getSession()
  if (!session) redirect("/sign-in?callbackUrl=/onboarding")
  const { state } = await searchParams
  const context = verifyInstallState(state ?? "")
  let permitted = false
  if (context.valid && context.github?.purpose === "github-choose") {
    try {
      const { session: current } = await requirePermission(
        context.workspaceId,
        PERMISSIONS.integration.manage
      )
      permitted =
        matchesGitHubSession(context.github, session) &&
        matchesGitHubSession(context.github, current)
    } catch {
      /* A stale context or revoked membership cannot reveal candidates. */
    }
  }
  if (!permitted || !context.valid || context.github?.purpose !== "github-choose")
    return (
      <main className="mx-auto max-w-xl space-y-4 px-4 py-12">
        <h1 className="text-xl font-semibold">GitHub connection expired</h1>
        <p>Start a new connection from a workspace you manage.</p>
        <Link href="/onboarding" className="underline">
          Return to setup
        </Link>
      </main>
    )
  const returnUrl = new URL(githubReturnPath(context, session.userId), "https://return.invalid")
  returnUrl.searchParams.set("github", "cancelled")
  return (
    <GitHubInstallationChooser
      state={state!}
      workspaceId={context.workspaceId}
      candidates={context.github.candidates}
      returnPath={returnUrl.pathname + returnUrl.search}
    />
  )
}
