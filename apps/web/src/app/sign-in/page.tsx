"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { authClient } from "@lyrashield/auth"
import { ShieldCheck } from "lucide-react"
import { Button, Input, Spinner, GithubIcon } from "@lyrashield/ui"

export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    })

    if (signInError) {
      setError(signInError.message ?? "Sign in failed")
      setLoading(false)
      return
    }

    router.push("/dashboard")
    router.refresh()
  }

  async function handleGitHub() {
    setLoading(true)
    setError(null)
    try {
      await authClient.signIn.social({
        provider: "github",
        callbackURL: "/dashboard",
      })
    } catch {
      setError("GitHub sign in failed. Please try again.")
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center">
          <ShieldCheck className="mb-2 h-10 w-10 text-primary" />
          <h1 className="text-2xl font-bold">Welcome back</h1>
          <p className="text-sm text-muted-foreground">Sign in to your LyraShield account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="email">
              Email
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="password">
              Password
            </label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          )}

          <Button type="submit" disabled={loading} className="w-full">
            {loading && <Spinner className="mr-2" />}
            Sign in
          </Button>
        </form>

        <div className="my-4 flex items-center gap-2">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">OR</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <Button
          onClick={handleGitHub}
          disabled={loading}
          variant="secondary"
          className="w-full"
        >
          <GithubIcon className="mr-2 h-4 w-4" />
          Continue with GitHub
        </Button>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link href="/sign-up" className="font-medium text-primary hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  )
}
