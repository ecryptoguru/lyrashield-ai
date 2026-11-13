"use client"

import Link from "next/link"
import { Button } from "@lyrashield/ui"
import { ThemeToggle } from "@/components/theme-toggle"

export type ResendStatus = "idle" | "success" | "error" | "email-mismatch" | "already-verified"

export function EmailVerificationPanel({
  email,
  resendLoading,
  resendCooldown,
  resendStatus,
  onResend,
}: {
  email: string
  resendLoading: boolean
  resendCooldown: number
  resendStatus: ResendStatus
  onResend: () => void
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <ThemeToggle className="fixed top-4 right-4 z-10" />
      <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative w-full max-w-md">
        <div className="bg-card rounded-xl border p-6 text-center shadow-lg sm:p-8">
          <h2 className="text-xl font-semibold tracking-tight">Check your email</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            Check the inbox for {email}. If this address needs verification, a link will be sent.
            Follow the link to continue, and check spam or junk if it does not arrive.
          </p>
          <div className="mt-4 flex flex-col items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={resendLoading || resendCooldown > 0}
              onClick={onResend}
            >
              {resendLoading
                ? "Sending…"
                : resendCooldown > 0
                  ? `Resend in ${resendCooldown}s`
                  : resendStatus === "email-mismatch"
                    ? "Sign out and resend"
                    : "Resend verification email"}
            </Button>
            {resendStatus === "success" && (
              <p className="text-sm text-emerald-600" role="status">
                Request accepted. If this address needs verification, a link will be sent.
              </p>
            )}
            {resendStatus === "email-mismatch" && (
              <p className="text-destructive text-sm" role="alert">
                You are signed in with a different email. Sign out and resend to request a link for
                this address, or sign in to your existing account below.
              </p>
            )}
            {resendStatus === "already-verified" && (
              <p className="text-sm" role="status">
                Your signed-in account is already verified. Sign in to continue.
              </p>
            )}
            {resendStatus === "error" && (
              <p className="text-destructive text-sm" role="alert">
                Could not resend. Please try again.
              </p>
            )}
          </div>
          <p className="text-muted-foreground mt-4 text-sm">
            Already registered or verified?{" "}
            <Link href="/sign-in" className="text-primary font-medium hover:underline">
              Sign in
            </Link>
            {" or "}
            <Link href="/forgot-password" className="text-primary font-medium hover:underline">
              Reset your password
            </Link>
          </p>
        </div>
      </div>
    </main>
  )
}
