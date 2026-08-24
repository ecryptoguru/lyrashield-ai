"use client"

import { useState } from "react"
import Link from "next/link"
import { AlertCircle } from "lucide-react"
import { authClient, getAuthErrorMessage } from "@lyrashield/auth"
import { Button, FormField, Input, Spinner } from "@lyrashield/ui"
import { AuthSplitLayout } from "@/components/auth-split-layout"
import { ThemeToggle } from "@/components/theme-toggle"
import { consumePendingAuthCallback } from "@/lib/auth-callback"

export default function TwoFactorPage() {
  const [useRecoveryCode, setUseRecoveryCode] = useState(false)
  const [code, setCode] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function verify(event: React.FormEvent) {
    event.preventDefault()
    if (useRecoveryCode ? code.trim().length < 6 : !/^\d{6}$/.test(code)) {
      setError(
        useRecoveryCode
          ? "Enter one of your unused recovery codes."
          : "Enter the 6-digit code from your authenticator app."
      )
      return
    }

    setLoading(true)
    setError(null)
    try {
      const { error: verificationError } = useRecoveryCode
        ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
        : await authClient.twoFactor.verifyTotp({ code, trustDevice: false })
      if (verificationError) {
        setError(getAuthErrorMessage(verificationError) ?? "Verification failed.")
        return
      }
      window.location.assign(consumePendingAuthCallback())
    } catch {
      setError("Could not verify the code. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <ThemeToggle className="fixed top-4 right-4 z-10" />
      <AuthSplitLayout
        heading="Verify it’s you"
        subheading={
          useRecoveryCode
            ? "Use one saved recovery code. It will be consumed immediately."
            : "Enter the current code from your authenticator app."
        }
        footer={
          <p className="text-muted-foreground mt-6 text-center text-sm md:text-left">
            Need to restart?{" "}
            <Link href="/sign-in" className="text-primary font-medium hover:underline">
              Return to sign in
            </Link>
          </p>
        }
      >
        <div className="bg-card rounded-xl border p-6 shadow-lg sm:p-8">
          <form onSubmit={verify} className="space-y-4">
            <FormField
              label={useRecoveryCode ? "Recovery code" : "Authenticator code"}
              htmlFor="totp-code"
            >
              <Input
                id="totp-code"
                value={code}
                onChange={(event) =>
                  setCode(
                    useRecoveryCode
                      ? event.target.value.slice(0, 64)
                      : event.target.value.replace(/\D/g, "").slice(0, 6)
                  )
                }
                required
                autoFocus
                autoComplete={useRecoveryCode ? "off" : "one-time-code"}
                inputMode={useRecoveryCode ? "text" : "numeric"}
                pattern={useRecoveryCode ? undefined : "[0-9]{6}"}
                maxLength={useRecoveryCode ? 64 : 6}
                aria-describedby={error ? "totp-error" : "totp-help"}
                aria-invalid={Boolean(error)}
              />
            </FormField>
            <p id="totp-help" className="text-muted-foreground text-xs">
              {useRecoveryCode
                ? "Both administrators receive a security alert and the use is audited."
                : "Trusted-device bypass is disabled. Each sign-in requires your authenticator."}
            </p>
            {error && (
              <p
                id="totp-error"
                role="alert"
                aria-live="polite"
                className="bg-destructive/10 text-destructive border-destructive/30 flex items-start gap-2 rounded-md border p-3 text-sm font-medium"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}
            <Button
              type="submit"
              disabled={loading || (useRecoveryCode ? code.trim().length < 6 : code.length !== 6)}
              className="w-full"
              size="lg"
            >
              {loading && <Spinner className="mr-2" />}
              {useRecoveryCode ? "Use recovery code" : "Verify and continue"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setUseRecoveryCode((current) => !current)
                setCode("")
                setError(null)
              }}
            >
              {useRecoveryCode ? "Use authenticator instead" : "Use a recovery code"}
            </Button>
          </form>
        </div>
      </AuthSplitLayout>
    </>
  )
}
