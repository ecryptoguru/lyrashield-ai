"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { authClient, getAuthErrorMessage } from "@lyrashield/auth"
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

export default function SignUpPage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState(false)
  const [providers, setProviders] = useState({
    github: false,
    google: false,
    microsoft: false,
    socialSignUp: false,
  })

  useEffect(() => {
    const oauthError = new URLSearchParams(window.location.search).get("error")
    let oauthErrorTimer: number | undefined
    if (oauthError) {
      oauthErrorTimer = window.setTimeout(() => {
        setError(
          oauthError.toLowerCase() === "beta_invite_required"
            ? "This account is not on the production beta invite list."
            : "Social sign up could not be completed. Please try again."
        )
      }, 0)
      window.history.replaceState(null, "", "/sign-up")
    }

    void fetch("/api/auth/providers")
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          data: {
            github?: boolean
            google?: boolean
            microsoft?: boolean
            socialSignUp?: boolean
          } | null
        ) => {
          if (data) {
            setProviders({
              github: Boolean(data.github),
              google: Boolean(data.google),
              microsoft: Boolean(data.microsoft),
              socialSignUp: Boolean(data.socialSignUp),
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

      // When email verification is required the server returns token: null;
      // otherwise Better Auth signs the invited beta user in immediately.
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
    try {
      const { error: socialError } = await authClient.signIn.social({
        provider: "github",
        callbackURL: "/onboarding",
        errorCallbackURL: "/sign-up",
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
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: "/onboarding",
      })
    } catch {
      setError("Google sign up failed. Please try again.")
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
        callbackURL: "/onboarding",
        errorCallbackURL: "/sign-up",
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
      <ThemeToggle className="fixed top-4 right-4 z-10" />
      <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center">
          <div className="gradient-primary shadow-primary-glow mb-3 flex h-12 w-12 items-center justify-center rounded-xl">
            <ShieldCheck className="text-primary-foreground h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Create your beta account</h1>
          <p className="text-muted-foreground text-sm">LyraShield AI is currently invite-only.</p>
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

          {providers.socialSignUp &&
            (providers.github || providers.google || providers.microsoft) && (
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
                      <GoogleIcon className="mr-2 h-4 w-4" />
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
