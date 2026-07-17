"use client"

import Link from "next/link"
import { useState } from "react"
import { ShieldCheck } from "lucide-react"
import { authClient, getAuthErrorMessage } from "@lyrashield/auth"
import { Button, FormField, Input, Spinner } from "@lyrashield/ui"
import { ThemeToggle } from "@/components/theme-toggle"

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const { error: requestError } = await authClient.requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      })
      if (requestError) throw requestError
      setSent(true)
    } catch (cause) {
      setError(getAuthErrorMessage(cause) ?? "Could not send a reset link. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <ThemeToggle className="fixed top-4 right-4 z-10" />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center">
          <div className="gradient-primary mb-3 flex h-12 w-12 items-center justify-center border p-1">
            <ShieldCheck className="text-primary-foreground h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Reset your password</h1>
          <p className="text-muted-foreground text-center text-sm">
            We’ll send a link if this email has an account.
          </p>
        </div>
        <div className="bg-card border p-6 shadow-sm sm:p-8">
          {sent ? (
            <p className="text-muted-foreground text-sm" role="status">
              Check your inbox for a password-reset link. If an account exists, it will arrive
              shortly.
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <FormField label="Email" htmlFor="email">
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                />
              </FormField>
              {error && (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={loading} className="w-full" size="lg">
                {loading && <Spinner className="mr-2" />}Send reset link
              </Button>
            </form>
          )}
        </div>
        <p className="text-muted-foreground mt-6 text-center text-sm">
          <Link href="/sign-in" className="text-primary font-medium hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  )
}
