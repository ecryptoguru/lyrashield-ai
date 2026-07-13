"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { authClient, getAuthErrorMessage } from "@lyrashield/auth"
import { ShieldCheck } from "lucide-react"
import { Button, Input, Spinner, GithubIcon, MicrosoftIcon, FormField } from "@lyrashield/ui"

export default function SignUpPage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { data, error: signUpError } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: "/onboarding",
    })

    if (signUpError) {
      setError(getAuthErrorMessage(signUpError) ?? "Sign up failed")
      setLoading(false)
      return
    }

    // When email verification is required the server returns token: null;
    // when auto-sign-in is allowed it returns a session token.
    if (data?.token) {
      router.push("/onboarding")
      router.refresh()
      return
    }

    setEmailSent(true)
    setLoading(false)
  }

  async function handleGitHub() {
    setLoading(true)
    setError(null)
    try {
      await authClient.signIn.social({
        provider: "github",
        callbackURL: "/onboarding",
      })
    } catch {
      setError("GitHub sign up failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleMicrosoft() {
    setLoading(true)
    setError(null)
    try {
      await authClient.signIn.oauth2({
        providerId: "microsoft-entra-id",
        callbackURL: "/onboarding",
      })
    } catch {
      setError("Microsoft sign up failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  if (emailSent) {
    return (
      <main className="relative flex min-h-screen items-center justify-center px-4">
        <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative w-full max-w-md">
          <div className="bg-card rounded-xl border p-6 text-center shadow-lg sm:p-8">
            <h2 className="text-xl font-semibold tracking-tight">Check your email</h2>
            <p className="text-muted-foreground mt-2 text-sm">
              We sent a verification link to {email}. Click it to verify your account and continue.
            </p>
            <p className="text-muted-foreground mt-4 text-sm">
              Already verified?{" "}
              <Link href="/sign-in" className="text-primary font-medium hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center">
          <div className="gradient-primary shadow-primary-glow mb-3 flex h-12 w-12 items-center justify-center rounded-xl">
            <ShieldCheck className="text-primary-foreground h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
          <p className="text-muted-foreground text-sm">Start securing your apps with LyraShield</p>
        </div>

        <div className="bg-card rounded-xl border p-6 shadow-lg sm:p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <FormField label="Name" htmlFor="name">
              <Input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
                placeholder="Jane Doe"
              />
            </FormField>
            <FormField label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
            </FormField>
            <FormField label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="At least 8 characters"
              />
            </FormField>

            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading} className="w-full" size="lg">
              {loading && <Spinner className="mr-2" />}
              Create account
            </Button>
          </form>

          <div className="my-6 flex items-center gap-3">
            <div className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-xs font-medium">OR</span>
            <div className="bg-border h-px flex-1" />
          </div>

          <div className="space-y-3">
            <Button
              onClick={handleGitHub}
              disabled={loading}
              variant="secondary"
              className="w-full"
              size="lg"
            >
              <GithubIcon className="mr-2 h-4 w-4" aria-hidden="true" />
              Sign up with GitHub
            </Button>
            <Button
              onClick={handleMicrosoft}
              disabled={loading}
              variant="secondary"
              className="w-full"
              size="lg"
            >
              <MicrosoftIcon className="mr-2 h-4 w-4" aria-hidden="true" />
              Sign up with Microsoft
            </Button>
          </div>
        </div>

        <p className="text-muted-foreground mt-6 text-center text-sm">
          Already have an account?{" "}
          <Link href="/sign-in" className="text-primary font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  )
}
