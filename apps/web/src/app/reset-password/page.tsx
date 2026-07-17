"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ShieldCheck } from "lucide-react"
import { authClient, getAuthErrorMessage } from "@lyrashield/auth"
import { Button, FormField, Input, Spinner } from "@lyrashield/ui"
import { ThemeToggle } from "@/components/theme-toggle"

export default function ResetPasswordPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const token = searchParams.get("token")

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!token) {
      setError("This reset link is invalid or has expired. Request a new one.")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { error: resetError } = await authClient.resetPassword({ newPassword: password, token })
      if (resetError) throw resetError
      router.push("/sign-in")
      router.refresh()
    } catch (cause) {
      setError(getAuthErrorMessage(cause) ?? "Could not reset your password. Request a new link.")
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
          <h1 className="text-2xl font-bold tracking-tight">Choose a new password</h1>
        </div>
        <div className="bg-card border p-6 shadow-sm sm:p-8">
          <form onSubmit={submit} className="space-y-4">
            <FormField label="New password" htmlFor="password">
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
                placeholder="At least 8 characters"
              />
            </FormField>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <Button type="submit" disabled={loading} className="w-full" size="lg">
              {loading && <Spinner className="mr-2" />}Reset password
            </Button>
          </form>
        </div>
        <p className="text-muted-foreground mt-6 text-center text-sm">
          <Link href="/forgot-password" className="text-primary font-medium hover:underline">
            Request a new link
          </Link>
        </p>
      </div>
    </main>
  )
}
