"use client"

import { useState, type FormEvent } from "react"
import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import { Button, Card, Spinner } from "@lyrashield/ui"
import { apiPost } from "@/lib/api-client"
import type { ReleasePacketIdentity } from "./release-packet-create"

interface ReleasePacketResult {
  reportId: string
  packetChecksum: string
  shareUrl: string | null
}

export function ReleasePacketForm({
  workspaceId,
  targetId,
  identity,
}: {
  workspaceId: string
  targetId: string
  identity: ReleasePacketIdentity
}) {
  const [share, setShare] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ReleasePacketResult | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreating(true)
    setError(null)
    setResult(null)
    try {
      const created = await apiPost<ReleasePacketResult>("/api/reports/release-packet", {
        workspaceId,
        targetId,
        ...(identity.kind === "COMMIT"
          ? { commit: identity.value }
          : { artifactDigest: identity.value }),
        share,
      })
      setResult(created)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create the release packet")
    } finally {
      setCreating(false)
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <ShieldCheck className="text-primary mt-0.5 size-5" aria-hidden="true" />
        <div>
          <h2 className="font-semibold">Create a private release packet</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            The packet freezes the stored verdict, assessed revision, coverage, blockers and trusted
            retest history. It does not recalculate readiness.
          </p>
        </div>
      </div>
      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground text-xs">Target</dt>
          <dd className="mt-1 break-all font-mono">{targetId}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Exact release</dt>
          <dd className="mt-1 break-all font-mono">{identity.value}</dd>
        </div>
      </dl>
      <form className="mt-5 space-y-4" onSubmit={submit}>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={share}
            onChange={(event) => setShare(event.target.checked)}
          />
          <span>
            Create a revocable private link
            <span className="text-muted-foreground mt-1 block text-xs">
              The link also requires a signed-in member with report access. It is never exposed by
              the public shared-report route.
            </span>
          </span>
        </label>
        {error && (
          <p
            role="alert"
            className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm"
          >
            {error}
          </p>
        )}
        <Button type="submit" disabled={creating} className="min-h-11">
          {creating ? <Spinner className="mr-2 size-4" /> : null}
          {creating ? "Creating packet…" : "Create immutable packet"}
        </Button>
      </form>
      <div aria-live="polite" aria-atomic="true">
        {result && (
          <div className="border-success/40 bg-success/5 mt-5 space-y-3 rounded-lg border p-4 text-sm">
            <p className="font-medium">Release packet created.</p>
            <p className="break-all font-mono text-xs">SHA-256: {result.packetChecksum}</p>
            <div className="flex flex-wrap gap-3">
              {result.shareUrl && (
                <a
                  href={result.shareUrl}
                  className="text-primary min-h-11 inline-flex items-center font-medium hover:underline"
                >
                  Open private packet
                </a>
              )}
              <Link
                href="/dashboard/reports"
                className="text-primary min-h-11 inline-flex items-center font-medium hover:underline"
              >
                View reports
              </Link>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
