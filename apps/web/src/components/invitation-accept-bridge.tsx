"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, PartyPopper, XCircle } from "lucide-react"
import { clearPendingInvitation, readPendingInvitation } from "@/lib/pending-invitation"

type AcceptOutcome = { kind: "joined"; workspaceName: string } | { kind: "error"; message: string }

/**
 * Redeems a pending team invitation after authentication. The invite link
 * (`/sign-up?invite=<token>`) stores the token on the auth pages; whichever
 * authenticated page renders this bridge (dashboard layout, onboarding)
 * completes the join automatically — the user never has to paste anything.
 *
 * Terminal outcomes (accepted, invalid, expired, wrong account) always clear
 * the stored token so it cannot retrigger on navigation.
 */
export function InvitationAcceptBridge() {
  const router = useRouter()
  const [outcome, setOutcome] = useState<AcceptOutcome | null>(null)
  const [dismissed, setDismissed] = useState(false)

  const accept = useCallback(async () => {
    const token = readPendingInvitation()
    if (!token) return
    try {
      const response = await fetch("/api/team/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
      const data = (await response.json().catch(() => null)) as {
        data?: { workspaceName?: string }
        error?: { message?: string }
      } | null
      if (response.ok) {
        setOutcome({
          kind: "joined",
          workspaceName: data?.data?.workspaceName ?? "your team workspace",
        })
        router.refresh()
      } else {
        setOutcome({
          kind: "error",
          message: data?.error?.message ?? "Your team invitation could not be accepted.",
        })
      }
    } catch {
      // Transient network failure: keep the token for the next page load.
      return
    }
    clearPendingInvitation()
  }, [router])

  useEffect(() => {
    // Deferred kickoff so the linter's synchronous-setState rule can see the
    // state updates happen asynchronously (they are already after an await).
    const timer = window.setTimeout(() => void accept(), 0)
    return () => window.clearTimeout(timer)
  }, [accept])

  if (!outcome || dismissed) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[92vw] items-start gap-2 rounded-lg border bg-background p-3 text-sm shadow-lg"
    >
      {outcome.kind === "joined" ? (
        <>
          <PartyPopper className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <p>
            You joined <strong>{outcome.workspaceName}</strong>. It is now available in your
            workspace switcher.
          </p>
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        </>
      ) : (
        <>
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <p>{outcome.message}</p>
        </>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-2 shrink-0 rounded px-1 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  )
}
