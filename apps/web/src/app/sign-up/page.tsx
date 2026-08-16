"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { AlertCircle } from "lucide-react"
import { authClient, getAuthErrorMessage } from "@lyrashield/auth"
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
import {
  readSignupAttribution,
  signupErrorUrl,
  track,
  type SignupAttribution,
} from "@/lib/analytics"
import { storePendingInvitation } from "@/lib/pending-invitation"

const marketingUrl = (process.env.NEXT_PUBLIC_MARKETING_URL || "https://lyrashieldai.com").replace(
  /\/$/,
  ""
)

export default function SignUpPage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState(false)
  const [resendLoading, setResendLoading] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendStatus, setResendStatus] = useState<"idle" | "success" | "error">("idle")
  const [providers, setProviders] = useState({
    github: false,
    google: false,
    microsoft: false,
    emailVerification: false,
  })
  // Until the client-side provider probe resolves we cannot distinguish
  // "no OAuth configured" from "still loading" — rendering nothing makes the
  // page look like a bare credentials form. Show a skeleton instead.
  const [providersLoading, setProvidersLoading] = useState(true)
  const attribution = useRef<SignupAttribution>({})
  const [invited, setInvited] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    // Team invitation link: stash the token for the post-auth bridge and
    // strip it from the URL so it cannot leak into redirects or analytics.
    const inviteToken = params.get("invite")
    let inviteTimer: number | undefined
    if (inviteToken) {
      storePendingInvitation(inviteToken)
      params.delete("invite")
      const cleaned = params.toString()
      window.history.replaceState(null, "", cleaned ? `?${cleaned}` : window.location.pathname)
      // Deferred like the OAuth error banner below: setState must not fire
      // synchronously inside the effect body.
      inviteTimer = window.setTimeout(() => setInvited(true), 0)
    }
    const nextAttribution = readSignupAttribution(window.location.search)
    const oauthError = params.get("error")
    attribution.current = nextAttribution
    track("signup_page_viewed", nextAttribution)
    let oauthErrorTimer: number | undefined
    if (oauthError) {
      oauthErrorTimer = window.setTimeout(() => {
        setError("Social sign up could not be completed. Please try again.")
      }, 0)
      window.history.replaceState(null, "", signupErrorUrl(nextAttribution))
    }

    void fetch("/api/auth/providers", { signal: AbortSignal.timeout(5_000) })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          data: {
            github?: boolean
            google?: boolean
            microsoft?: boolean
            emailVerification?: boolean
          } | null
        ) => {
          if (data) {
            setProviders({
              github: Boolean(data.github),
              google: Boolean(data.google),
              microsoft: Boolean(data.microsoft),
              emailVerification: Boolean(data.emailVerification),
            })
          }
        }
      )
      .catch(() => {})
      .finally(() => setProvidersLoading(false))

    return () => {
      if (oauthErrorTimer !== undefined) window.clearTimeout(oauthErrorTimer)
      if (inviteTimer !== undefined) window.clearTimeout(inviteTimer)
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    track("signup_started", { method: "email", ...attribution.current })

    try {
      const { data, error: signUpError } = await authClient.signUp.email({
        name,
        email,
        password,
        callbackURL: "/onboarding",
      })

      if (signUpError) {
        setError(getAuthErrorMessage(signUpError) ?? "Sign up failed")
        return
      }

      track("account_created", { method: "email", ...attribution.current })

      // When email verification is required the server returns token: null;
      // otherwise Better Auth signs the new user in immediately.
      if (data?.token) {
        router.push("/onboarding")
        router.refresh()
        return
      }

      if (providers.emailVerification) {
        setEmailSent(true)
      } else {
        setError(
          "Your account was created, but automatic sign-in did not complete. Please sign in."
        )
      }
    } catch {
      setError("Could not create your account. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleGitHub() {
    setLoading(true)
    setError(null)
    track("signup_started", { method: "github", ...attribution.current })
    try {
      const { error: socialError } = await authClient.signIn.social({
        provider: "github",
        callbackURL: "/onboarding",
        errorCallbackURL: signupErrorUrl(attribution.current),
      })
      if (socialError) {
        setError(getAuthErrorMessage(socialError) ?? "GitHub sign up failed. Please try again.")
      }
    } catch {
      setError("GitHub sign up failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogle() {
    setLoading(true)
    setError(null)
    track("signup_started", { method: "google", ...attribution.current })
    try {
      const { error: socialError } = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/onboarding",
        errorCallbackURL: signupErrorUrl(attribution.current),
      })
      if (socialError) {
        setError(getAuthErrorMessage(socialError) ?? "Google sign up failed. Please try again.")
      }
    } catch {
      setError("Google sign up failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleMicrosoft() {
    setLoading(true)
    setError(null)
    track("signup_started", { method: "microsoft", ...attribution.current })
    try {
      const { error: socialError } = await authClient.signIn.social({
        provider: "microsoft",
        callbackURL: "/onboarding",
        errorCallbackURL: signupErrorUrl(attribution.current),
      })
      if (socialError) {
        setError(getAuthErrorMessage(socialError) ?? "Microsoft sign up failed. Please try again.")
      }
    } catch {
      setError("Microsoft sign up failed. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    setResendLoading(true)
    setResendStatus("idle")
    try {
      await authClient.sendVerificationEmail({ email, callbackURL: "/onboarding" })
      setResendStatus("success")
      setResendCooldown(30)
      const tick = () => {
        setResendCooldown((prev) => {
          if (prev <= 1) return 0
          window.setTimeout(tick, 1000)
          return prev - 1
        })
      }
      window.setTimeout(tick, 1000)
    } catch {
      setResendStatus("error")
    } finally {
      setResendLoading(false)
    }
  }

  if (emailSent) {
    return (
      <main className="relative flex min-h-screen items-center justify-center px-4">
        <ThemeToggle className="fixed top-4 right-4 z-10" />
        <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative w-full max-w-md">
          <div className="bg-card rounded-xl border p-6 text-center shadow-lg sm:p-8">
            <h2 className="text-xl font-semibold tracking-tight">Check your email</h2>
            <p className="text-muted-foreground mt-2 text-sm">
              We sent a verification link to {email}. Click it to verify your account and continue.
            </p>
            <div className="mt-4 flex flex-col items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={resendLoading || resendCooldown > 0}
                onClick={() => void handleResend()}
              >
                {resendLoading
                  ? "Sending…"
                  : resendCooldown > 0
                    ? `Resend in ${resendCooldown}s`
                    : "Resend verification email"}
              </Button>
              {resendStatus === "success" && (
                <p className="text-sm text-emerald-600" role="status">
                  Verification email resent.
                </p>
              )}
              {resendStatus === "error" && (
                <p className="text-destructive text-sm" role="alert">
                  Could not resend. Please try again.
                </p>
              )}
            </div>
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
    <>
      <ThemeToggle className="fixed top-4 right-4 z-10" />
      <AuthSplitLayout
        heading="Create your account"
        subheading="Start your evidence-backed release workflow."
        footer={
          <p className="text-muted-foreground mt-6 text-center text-sm md:text-left">
            {invited ? (
              <div
                role="status"
                className="mb-4 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm"
              >
                You have a pending team invitation — it will be accepted automatically once you
                create your account and sign in.
              </div>
            ) : null}
            Already have an account?{" "}
            <Link href="/sign-in" className="text-primary font-medium hover:underline">
              Sign in
            </Link>
          </p>
        }
      >
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
              <PasswordInput
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                aria-describedby="password-hint"
              />
              <p id="password-hint" className="text-muted-foreground mt-1.5 text-xs">
                At least 8 characters. Use a mix of letters, numbers, and symbols for a stronger
                password.
              </p>
            </FormField>

            {error && (
              <p
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
              Create account
            </Button>

            <p className="text-muted-foreground text-center text-xs leading-relaxed">
              By creating an account you agree to the{" "}
              <Link
                href={`${marketingUrl}/terms`}
                className="text-foreground hover:text-primary font-medium underline underline-offset-4"
              >
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link
                href={`${marketingUrl}/privacy`}
                className="text-foreground hover:text-primary font-medium underline underline-offset-4"
              >
                Privacy Policy
              </Link>
              .
            </p>
          </form>

          {providersLoading && (
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
              <span className="sr-only" role="status">
                Loading sign-up options
              </span>
            </div>
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
                    Sign up with GitHub
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
                    Sign up with Google
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
                    Sign up with Microsoft
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
