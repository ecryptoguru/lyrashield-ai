"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { authClient, getAuthErrorMessage, isEmailNotVerifiedError } from "@lyrashield/auth"
import { ShieldCheck } from "lucide-react"
import {
  Button,
  Input,
  Spinner,
  GithubIcon,
  GoogleIcon,
  MicrosoftIcon,
  FormField,
} from "@lyrashield/ui"
import { ThemeToggle } from "@/components/theme-toggle"

export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState(false)
  const [providers, setProviders] = useState({
    github: false,
    google: false,
    microsoft: false,
    passwordReset: false,
  })

  useEffect(() => {
    const oauthError = new URLSearchParams(window.location.search).get("error")
    let oauthErrorTimer: number | undefined
    if (oauthError) {
      oauthErrorTimer = window.setTimeout(() => {
        const normalizedError = oauthError.toLowerCase()
        setError(
          normalizedError === "beta_invite_required"
            ? "This account is not on the production beta invite list."
            : normalizedError === "signup_disabled"
              ? "Sign in with your invited email first, then connect Microsoft from Settings."
              : "Social sign in could not be completed. Please try again."
        )
      }, 0)
      window.history.replaceState(null, "", "/sign-in")
    }

    void fetch("/api/auth/providers")
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          data: {
            github?: boolean
            google?: boolean
            microsoft?: boolean
            passwordReset?: boolean
          } | null
        ) => {
          if (data) {
            setProviders({
              github: Boolean(data.github),
              google: Boolean(data.google),
              microsoft: Boolean(data.microsoft),
              passwordReset: Boolean(data.passwordReset),
            })
          }
        }
      )
      .catch(() => {})

    return () => {
      if (oauthErrorTimer !== undefined) window.clearTimeout(oauthErrorTimer)
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const { error: signInError } = await authClient.signIn.email({
        email,
        password,
        callbackURL: "/dashboard",
      })

      if (signInError) {
        if (isEmailNotVerifiedError(signInError)) {
          setEmailSent(true)
        } else {
          setError(getAuthErrorMessage(signInError) ?? "Sign in failed")
        }
        return
      }

      router.push("/dashboard")
      router.refresh()
    } catch {
      setError("Could not sign in. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleGitHub() {
    setLoading(true)
    setError(null)
    try {
      await authClient.signIn.social({
        provider: "github",
        callbackURL: "/dashboard",
        errorCallbackURL: "/sign-in",
      })
    } catch {
      setError("GitHub sign in failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogle() {
    setLoading(true)
    setError(null)
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: "/dashboard",
        errorCallbackURL: "/sign-in",
      })
    } catch {
      setError("Google sign in failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleMicrosoft() {
    setLoading(true)
    setError(null)
    try {
      await authClient.signIn.social({
        provider: "microsoft",
        callbackURL: "/dashboard",
        errorCallbackURL: "/sign-in",
      })
    } catch {
      setError("Microsoft sign in failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  if (emailSent) {
    return (
      <main className="relative flex min-h-screen items-center justify-center px-4">
        <ThemeToggle className="fixed top-4 right-4 z-10" />
        <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative w-full max-w-md">
          <div className="mb-8 flex flex-col items-center">
            <div className="gradient-primary shadow-primary-glow mb-3 flex h-12 w-12 items-center justify-center rounded-xl">
              <ShieldCheck className="text-primary-foreground h-7 w-7" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Check your email</h1>
          </div>

          <div className="bg-card rounded-xl border p-6 text-center shadow-lg sm:p-8">
            <p className="text-muted-foreground text-sm">
              We sent a verification link to {email}. Click it to verify your account, then sign in.
            </p>
            <button
              type="button"
              onClick={() => setEmailSent(false)}
              className="text-primary mt-4 inline-block text-sm font-medium hover:underline"
            >
              Try signing in again
            </button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <ThemeToggle className="fixed top-4 right-4 z-10" />
      <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center">
          <div className="gradient-primary shadow-primary-glow mb-3 flex h-12 w-12 items-center justify-center rounded-xl">
            <ShieldCheck className="text-primary-foreground h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
          <p className="text-muted-foreground text-sm">Sign in to your LyraShield account</p>
        </div>

        <div className="bg-card rounded-xl border p-6 shadow-lg sm:p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
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
                autoComplete="current-password"
                placeholder="••••••••"
              />
            </FormField>
            {providers.passwordReset && (
              <div className="flex justify-end">
                <Link
                  href="/forgot-password"
                  className="text-primary min-h-11 py-2 text-sm font-medium hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
            )}

            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading} className="w-full" size="lg">
              {loading && <Spinner className="mr-2" />}
              Sign in
            </Button>
          </form>

          {(providers.github || providers.google || providers.microsoft) && (
            <>
              <div className="my-6 flex items-center gap-3">
                <div className="bg-border h-px flex-1" />
                <span className="text-muted-foreground text-xs font-medium">OR</span>
                <div className="bg-border h-px flex-1" />
              </div>

              <div className="space-y-3">
                {providers.github && (
                  <Button
                    onClick={handleGitHub}
                    disabled={loading}
                    variant="secondary"
                    className="w-full"
                    size="lg"
                  >
                    <GithubIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                    Continue with GitHub
                  </Button>
                )}
                {providers.google && (
                  <Button
                    onClick={handleGoogle}
                    disabled={loading}
                    variant="secondary"
                    className="w-full"
                    size="lg"
                  >
                    <GoogleIcon className="mr-2 h-4 w-4" />
                    Continue with Google
                  </Button>
                )}
                {providers.microsoft && (
                  <Button
                    onClick={handleMicrosoft}
                    disabled={loading}
                    variant="secondary"
                    className="w-full"
                    size="lg"
                  >
                    <MicrosoftIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                    Continue with Microsoft
                  </Button>
                )}
              </div>
            </>
          )}
        </div>

        <p className="text-muted-foreground mt-6 text-center text-sm">
          Don&apos;t have an account?{" "}
          <Link href="/sign-up" className="text-primary font-medium hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </main>
  )
}
