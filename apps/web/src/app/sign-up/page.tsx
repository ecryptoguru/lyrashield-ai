"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { authClient } from "@lyrashield/auth"
import { ShieldCheck } from "lucide-react"
import { Button, Input, Spinner, GithubIcon, MicrosoftIcon, FormField } from "@lyrashield/ui"

export default function SignUpPage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error: signUpError } = await authClient.signUp.email({
      name,
      email,
      password,
    })

    if (signUpError) {
      setError(signUpError.message ?? "Sign up failed")
      setLoading(false)
      return
    }

    router.push("/onboarding")
    router.refresh()
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

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl gradient-primary shadow-primary-glow">
            <ShieldCheck className="h-7 w-7 text-primary-foreground" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
          <p className="text-sm text-muted-foreground">Start securing your apps with LyraShield</p>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-lg sm:p-8">
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
              <p className="text-sm text-destructive" role="alert">{error}</p>
            )}

            <Button type="submit" disabled={loading} className="w-full" size="lg">
              {loading && <Spinner className="mr-2" />}
              Create account
            </Button>
          </form>

          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs font-medium text-muted-foreground">OR</span>
            <div className="h-px flex-1 bg-border" />
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

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
