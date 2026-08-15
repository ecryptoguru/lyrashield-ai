"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { authClient, getAuthErrorMessage, isEmailNotVerifiedError } from "@lyrashield/auth"
import { ShieldCheck, AlertCircle } from "lucide-react"
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
import { AuthSplitLayout } from "@/components/auth-split-layout"
import { PasswordInput } from "@/components/password-input"
import { Skeleton } from "@/components/ui/skeleton"

export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [providers, setProviders] = useState({
    github: false,
    google: false,
    microsoft: false,
    passwordReset: false,
  })
  // The provider list is fetched client-side, so until it resolves we cannot
  // tell "no OAuth configured" from "probe still in flight". Without this the
  // page renders as a bare credentials form and reads as broken rather than
  // loading. Show a skeleton for the OAuth row while the probe is pending.
  const [providersLoading, setProvidersLoading] = useState(true)
  // Set when the /api/auth/providers probe fails (non-OK or network error).
  // Without this, a failed probe leaves the OAuth section absent with no
  // explanation — an OAuth-only user sees only a credentials form. (Deep Review v13.)
  const [providersError, setProvidersError] = useState(false)
  // Incremented by the Retry button to re-trigger the provider probe effect.
  const [providersRetryKey, setProvidersRetryKey] = useState(0)

  function callbackURL(): string {
    const requested = new URLSearchParams(window.location.search).get("callbackURL")
    return requested && requested.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/dashboard"
  }

  useEffect(() => {
    // Reference the retry key so react-hooks/exhaustive-deps sees it as used —
    // it is a re-trigger signal, not a data dependency. (Deep Review v13.)
    void providersRetryKey
    let active = true
    const oauthError = new URLSearchParams(window.location.search).get("error")
    let oauthErrorTimer: number | undefined
    if (oauthError) {
      oauthErrorTimer = window.setTimeout(() => {
        setError("Social sign in could not be completed. Please try again.")
      }, 0)
      // Strip only the error param so a valid callbackURL (e.g. /oauth/consent?…)
      // survives a sign-in retry. Previously the whole URL was rewritten,
      // dropping the caller's destination. (Deep Review v13.)
      const remaining = new URLSearchParams(window.location.search)
      remaining.delete("error")
      window.history.replaceState(
        null,
        "",
        "/sign-in" + (remaining.size ? `?${remaining.toString()}` : "")
      )
    }

    void authClient
      .getSession()
      .then(({ data }) => {
        if (!active) return
        if (data?.session) {
          router.replace("/dashboard")
          router.refresh()
          return
        }
        setCheckingSession(false)
      })
      .catch(() => {
        if (active) setCheckingSession(false)
      })

    void fetch("/api/auth/providers", { signal: AbortSignal.timeout(5_000) })
      .then((response) =>
        response.ok
          ? response.json().then((data) => ({ ok: true, data }))
          : Promise.resolve({ ok: false, data: null })
      )
      .then(({ ok, data }) => {
        if (!active) return
        if (data) {
          setProviders({
            github: Boolean(data.github),
            google: Boolean(data.google),
            microsoft: Boolean(data.microsoft),
            passwordReset: Boolean(data.passwordReset),
          })
        } else if (!ok) {
          // A null body on a non-OK response is a probe failure, not "no OAuth".
          // Surface it so the OAuth row doesn't silently vanish. (Deep Review v13.)
          setProvidersError(true)
        }
      })
      .catch(() => {
        if (active) setProvidersError(true)
      })
      .finally(() => {
        if (active) setProvidersLoading(false)
      })

    return () => {
      active = false
      if (oauthErrorTimer !== undefined) window.clearTimeout(oauthErrorTimer)
    }
  }, [router, providersRetryKey])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const { error: signInError } = await authClient.signIn.email({
        email,
        password,
        callbackURL: callbackURL(),
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
      const { error: socialError } = await authClient.signIn.social({
        provider: "github",
        callbackURL: callbackURL(),
        errorCallbackURL: "/sign-in",
      })
      if (socialError) {
        setError(getAuthErrorMessage(socialError) ?? "GitHub sign in failed. Please try again.")
      }
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
      const { error: socialError } = await authClient.signIn.social({
        provider: "google",
        callbackURL: callbackURL(),
        errorCallbackURL: "/sign-in",
      })
      if (socialError) {
        setError(getAuthErrorMessage(socialError) ?? "Google sign in failed. Please try again.")
      }
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
      const { error: socialError } = await authClient.signIn.social({
        provider: "microsoft",
        callbackURL: callbackURL(),
        errorCallbackURL: "/sign-in",
      })
      if (socialError) {
        setError(getAuthErrorMessage(socialError) ?? "Microsoft sign in failed. Please try again.")
      }
    } catch {
      setError("Microsoft sign in failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  if (checkingSession) {
    return (
      <main className="relative flex min-h-screen items-center justify-center px-4">
        <ThemeToggle className="fixed top-4 right-4 z-10" />
        <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative flex flex-col items-center gap-3" role="status">
          <Spinner className="h-6 w-6" />
          <p className="text-muted-foreground text-sm">Opening your workspace…</p>
        </div>
      </main>
    )
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
            <h2 className="text-2xl font-bold tracking-tight">Check your email</h2>
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
    <>
      <ThemeToggle className="fixed top-4 right-4 z-10" />
      <AuthSplitLayout
        heading="Welcome back"
        subheading="Sign in to your LyraShield account"
        footer={
          <p className="text-muted-foreground mt-6 text-center text-sm md:text-left">
            Don&apos;t have an account?{" "}
            <Link href="/sign-up" className="text-primary font-medium hover:underline">
              Sign up
            </Link>
          </p>
        }
      >
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
                autoFocus
                placeholder="you@example.com"
                aria-describedby={error ? "signin-error" : undefined}
                aria-invalid={error ? true : undefined}
              />
            </FormField>
            <FormField label="Password" htmlFor="password">
              <PasswordInput
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                aria-describedby={error ? "signin-error" : undefined}
                aria-invalid={error ? true : undefined}
              />
            </FormField>
            <div className="flex min-h-11 items-center justify-end">
              {providers.passwordReset ? (
                <Link
                  href="/forgot-password"
                  className="text-primary inline-flex min-h-11 items-center py-2 text-sm font-medium hover:underline"
                >
                  Forgot password?
                </Link>
              ) : (
                <p className="text-muted-foreground py-2 text-right text-xs">
                  Forgot your password? Email reset is coming soon.
                </p>
              )}
            </div>

            {error && (
              <p
                id="signin-error"
                role="alert"
                aria-live="polite"
                className="bg-destructive/10 text-destructive border-destructive/30 flex items-start gap-2 rounded-md border p-3 text-sm font-medium"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}

            <Button type="submit" disabled={loading} className="w-full" size="lg">
              {loading && <Spinner className="mr-2" />}
              Sign in
            </Button>
          </form>

          {providersLoading && (
            <>
              <div aria-hidden="true" data-testid="oauth-skeleton">
                <div className="my-6 flex items-center gap-3">
                  <div className="bg-border h-px flex-1" />
                  <span className="text-muted-foreground text-xs font-medium">OR</span>
                  <div className="bg-border h-px flex-1" />
                </div>
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              </div>
              {/* sr-only announcement lives outside the aria-hidden skeleton so
                  screen readers actually announce the loading state. (Deep Review v13.) */}
              <span className="sr-only" role="status">
                Loading sign-in options
              </span>
            </>
          )}

          {!providersLoading && providersError && (
            <p className="text-muted-foreground mt-6 text-sm" role="alert">
              Sign-in options could not be loaded.{" "}
              <button
                type="button"
                className="text-primary underline underline-offset-2"
                onClick={() => {
                  setProvidersError(false)
                  setProvidersLoading(true)
                  setProvidersRetryKey((k) => k + 1)
                }}
              >
                Retry
              </button>
            </p>
          )}

          {!providersLoading && (providers.github || providers.google || providers.microsoft) && (
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
                    <GoogleIcon className="mr-2 h-4 w-4" aria-hidden="true" />
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
      </AuthSplitLayout>
    </>
  )
}
