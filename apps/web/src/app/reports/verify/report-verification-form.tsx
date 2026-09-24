"use client"

import { useState, useSyncExternalStore, type FormEvent } from "react"
import { Button, Card } from "@lyrashield/ui"

type ReleaseIdentityStatus = "MATCH" | "MISMATCH" | "UNAVAILABLE"

type VerificationResult = {
  verified: boolean
  signingKeyId: string | null
  releaseIdentity?: { status: ReleaseIdentityStatus }
}

const fieldClass =
  "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"

function subscribeToNothing() {
  return () => {}
}

/**
 * Plain-language meaning for each release-identity outcome, shown beside the
 * status after a verification. The sentence never restates the stored identity —
 * the endpoint returns only the status.
 */
const RELEASE_IDENTITY_MEANINGS: Record<ReleaseIdentityStatus, string> = {
  MATCH: "the report is bound to the exact commit or digest you expected",
  MISMATCH: "the report is bound to a different commit or digest than you expected",
  UNAVAILABLE: "this report's release could not be confirmed from the link you provided",
}

/**
 * React attaches onSubmit only once the client has hydrated. A submit before that
 * would otherwise fall back to the browser's default GET navigation, which copies
 * the shared report URL — including its 64-character share token — into the
 * address bar, the browser history and any upstream request log. P2-7 fixes that
 * twice over: the form always posts (method="post" with an empty action, so no
 * field can ever reach a query string) and the submit control stays disabled
 * until hydration has happened.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false
  )
}

function parseSharedReportUrl(value: string): { reportId: string; shareToken: string } | null {
  try {
    const url = new URL(value)
    const match = url.pathname.match(/^\/reports\/shared\/([^/]+)$/)
    const shareToken = url.searchParams.get("token")
    return match?.[1] && shareToken ? { reportId: match[1], shareToken } : null
  } catch {
    return null
  }
}

export function ReportVerificationForm() {
  const hydrated = useHydrated()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<VerificationResult | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    setResult(null)

    const data = new FormData(event.currentTarget)
    const reportChecksum = String(data.get("reportChecksum") ?? "").trim()
    const signature = String(data.get("signature") ?? "").trim()
    const sharedReportUrl = String(data.get("sharedReportUrl") ?? "").trim()
    const expectedIdentity = String(data.get("expectedIdentity") ?? "").trim()

    let releaseIdentity: Record<string, string> | undefined
    if (sharedReportUrl || expectedIdentity) {
      const shared = parseSharedReportUrl(sharedReportUrl)
      if (!shared || !expectedIdentity) {
        setError("Provide both a valid shared report URL and the expected commit or digest.")
        setPending(false)
        return
      }
      releaseIdentity = {
        ...shared,
        kind: expectedIdentity.toLowerCase().startsWith("sha256:") ? "ARTIFACT_DIGEST" : "COMMIT",
        value: expectedIdentity,
      }
    }

    try {
      const response = await fetch("/api/reports/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reportChecksum,
          signature,
          ...(releaseIdentity && { releaseIdentity }),
        }),
      })
      const body = (await response.json()) as {
        data?: VerificationResult
        error?: { message?: string }
      }
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Verification failed")
      setResult(body.data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Verification failed")
    } finally {
      setPending(false)
    }
  }

  return (
    <Card className="p-6">
      {/*
        method="post" plus an empty action keeps every field out of the URL: the
        empty action submits to this path, and a POST has no query string. The
        React handler below still runs preventDefault and drives the fetch.
      */}
      <form className="space-y-5" method="post" action="" onSubmit={submit}>
        <label className="block text-sm font-medium">
          Report checksum
          <input
            className={fieldClass}
            name="reportChecksum"
            required
            pattern="[A-Fa-f0-9]{64}"
            placeholder="64-character SHA-256 hex digest"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="block text-sm font-medium">
          Ed25519 signature
          <textarea
            className={`${fieldClass} min-h-24 resize-y font-mono`}
            name="signature"
            required
            maxLength={512}
            placeholder="Base64 ed25519 signature, one line with no spaces"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <fieldset className="space-y-4 border-t border-border pt-5">
          <legend className="text-sm font-semibold">Optional release confirmation</legend>
          <p className="text-xs text-muted-foreground">
            Both fields are required for this check. The response confirms only match, mismatch or
            unavailable; it never returns the report&apos;s stored identity.
          </p>
          <label className="block text-sm font-medium">
            Shared report URL
            <input
              className={fieldClass}
              name="sharedReportUrl"
              type="url"
              placeholder="https://app.lyrashieldai.com/reports/shared/...?token=..."
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="block text-sm font-medium">
            Expected commit or artifact digest
            <input
              className={`${fieldClass} font-mono`}
              name="expectedIdentity"
              placeholder="40-character commit or sha256:..."
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </fieldset>

        <Button type="submit" disabled={pending || !hydrated}>
          {pending ? "Verifying…" : hydrated ? "Verify report" : "Loading…"}
        </Button>
      </form>

      {error && (
        <p
          role="alert"
          className="mt-5 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900"
        >
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="mt-5 rounded-md border border-border bg-muted/40 p-4 text-sm">
          <p className="font-semibold">
            {result.verified
              ? "Signature valid — this exact report was issued by LyraShield."
              : "Signature invalid — do not rely on this report."}
          </p>
          {result.releaseIdentity && (
            <p className="mt-2 text-muted-foreground">
              Release identity: {result.releaseIdentity.status.toLowerCase()} —{" "}
              {RELEASE_IDENTITY_MEANINGS[result.releaseIdentity.status]}.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
