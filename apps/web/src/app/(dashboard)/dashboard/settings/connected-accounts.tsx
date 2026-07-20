"use client"

import { useEffect, useState } from "react"
import { authClient, getAuthErrorMessage } from "@lyrashield/auth"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  GithubIcon,
  GoogleIcon,
  MicrosoftIcon,
  Spinner,
} from "@lyrashield/ui"

type ProviderId = "github" | "google" | "microsoft"

const providerDetails = [
  { id: "github", label: "GitHub", icon: GithubIcon },
  { id: "google", label: "Google", icon: GoogleIcon },
  { id: "microsoft", label: "Microsoft", icon: MicrosoftIcon },
] as const

export function ConnectedAccounts() {
  const [available, setAvailable] = useState<Record<ProviderId, boolean>>({
    github: false,
    google: false,
    microsoft: false,
  })
  const [connected, setConnected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState<ProviderId | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const callbackError = new URLSearchParams(window.location.search).get("error")
    let callbackErrorTimer: number | undefined

    if (callbackError) {
      callbackErrorTimer = window.setTimeout(() => {
        setError(
          callbackError === "account_link_failed"
            ? "Could not connect the account. Please try again."
            : "Account linking could not be completed. Please try again."
        )
      }, 0)
      window.history.replaceState(null, "", "/dashboard/settings")
    }

    void Promise.all([
      fetch("/api/auth/providers", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("Provider discovery failed")
        return response.json()
      }),
      authClient.listAccounts(),
    ])
      .then(([providerData, accountResult]) => {
        if (!active) return
        if (accountResult.error) throw accountResult.error
        setAvailable({
          github: Boolean(providerData?.github),
          google: Boolean(providerData?.google),
          microsoft: Boolean(providerData?.microsoft),
        })
        setConnected(new Set((accountResult.data ?? []).map((account) => account.providerId)))
      })
      .catch(() => {
        if (active) setError("Could not load connected accounts. Please refresh and try again.")
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
      if (callbackErrorTimer !== undefined) window.clearTimeout(callbackErrorTimer)
    }
  }, [])

  async function connect(provider: ProviderId) {
    setConnecting(provider)
    setError(null)
    try {
      const { error: linkError } = await authClient.linkSocial({
        provider,
        callbackURL: "/dashboard/settings",
        errorCallbackURL: "/dashboard/settings?error=account_link_failed",
      })
      if (linkError) {
        setError(getAuthErrorMessage(linkError) ?? `Could not connect ${provider}.`)
      }
    } catch {
      setError(`Could not connect ${provider}. Please try again.`)
    } finally {
      setConnecting(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign-in methods</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm leading-6">
          Connect a provider while signed in so you can use it safely on future visits. Your account
          email remains the identity for this beta.
        </p>

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <div className="text-muted-foreground flex min-h-12 items-center gap-2 text-sm">
            <Spinner className="h-4 w-4" />
            Loading sign-in methods…
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {providerDetails.filter((provider) => available[provider.id]).length === 0 ? (
              <p className="text-muted-foreground text-sm">No social providers are configured.</p>
            ) : (
              providerDetails
                .filter((provider) => available[provider.id])
                .map((provider) => {
                  const Icon = provider.icon
                  const isConnected = connected.has(provider.id)
                  return (
                    <div
                      key={provider.id}
                      className="bg-card/50 flex min-w-0 items-center justify-between gap-3 rounded-xl border p-3"
                    >
                      <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">{provider.label}</span>
                      </span>
                      {isConnected ? (
                        <Badge variant="success">Connected</Badge>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={connecting !== null}
                          onClick={() => void connect(provider.id)}
                        >
                          {connecting === provider.id && <Spinner className="mr-2 h-4 w-4" />}
                          Connect
                        </Button>
                      )}
                    </div>
                  )
                })
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
