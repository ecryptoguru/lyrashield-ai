"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"
import { Button, Card } from "@lyrashield/ui"
import { apiGet, apiPost, apiPut } from "@/lib/api-client"
import { formatDateTimeUtc } from "@/lib/date-format"
import { formatTargetDomainStatus } from "@/lib/target-domain-status-format"

const proofSchema = z.object({
  id: z.string(),
  domain: z.string(),
  status: z.string(),
  expiresAt: z.iso.datetime(),
  method: z.string().optional(),
})
const issueSchema = z.object({
  verification: proofSchema,
  dns: z.object({ host: z.string(), value: z.string() }),
})
type Proof = z.infer<typeof proofSchema>

export function DomainVerificationCard(props: {
  workspaceId: string
  domain: string | null
  canValidate: boolean
  initialStatus: string
}) {
  // Remount on workspace/target changes so no previous workspace proof is rendered.
  return (
    <DomainVerificationContent
      key={`${props.workspaceId}:${props.domain}:${props.canValidate}`}
      {...props}
    />
  )
}

function DomainVerificationContent({
  workspaceId,
  domain,
  canValidate,
  initialStatus,
}: {
  workspaceId: string
  domain: string | null
  canValidate: boolean
  initialStatus: string
}) {
  const router = useRouter()
  const [proof, setProof] = useState<Proof | null>(null)
  const [dns, setDns] = useState<{ host: string; value: string } | null>(null)
  const [busy, setBusy] = useState(canValidate && !!domain)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!canValidate || !domain) return
    const controller = new AbortController()
    void apiGet(`/api/target-domain-verifications?${new URLSearchParams({ workspaceId })}`, {
      schema: z.array(proofSchema),
      signal: controller.signal,
      cache: "no-store",
    })
      .then((rows) => {
        if (!controller.signal.aborted) setProof(rows.find((row) => row.domain === domain) ?? null)
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load domain verification.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [workspaceId, domain, canValidate, attempt])

  const expired = !!proof && new Date(proof.expiresAt).getTime() <= now
  const initialExpiry = initialStatus.startsWith("Verified until ")
    ? Date.parse(initialStatus.slice(15))
    : null
  const status = proof
    ? expired
      ? "Not verified (expired)"
      : proof.status === "VERIFIED"
        ? `Verified until ${formatDateTimeUtc(proof.expiresAt)}`
        : initialStatus === "Self-attested"
          ? initialStatus
          : "Not verified"
    : initialExpiry !== null && initialExpiry <= now
      ? "Not verified (expired)"
      : canValidate && initialExpiry !== null
        ? "Not verified"
        : formatTargetDomainStatus(initialStatus)

  async function mutate(issue: boolean) {
    setBusy(true)
    setError(null)
    setMessage("")
    try {
      if (issue) {
        // A response can be lost after issuance invalidates the old proof.
        setProof(null)
        setDns(null)
        const result = await apiPost(
          "/api/target-domain-verifications",
          { workspaceId, domain },
          { schema: issueSchema }
        )
        setProof(result.verification)
        setDns(result.dns)
        setMessage(
          "New TXT record issued. Replace any previous record with these values; the previous proof is invalid."
        )
      } else if (proof) {
        const result = await apiPut(
          "/api/target-domain-verifications",
          { workspaceId, verificationId: proof.id },
          { schema: proofSchema }
        )
        if (
          result.domain !== domain ||
          result.status !== "VERIFIED" ||
          Date.parse(result.expiresAt) <= Date.now()
        )
          throw new Error("Domain verification did not succeed.")
        setProof(result)
        setMessage("Domain verified successfully.")
      }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify domain.")
    } finally {
      setBusy(false)
    }
  }

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setMessage(`${label} copied.`)
    } catch {
      setError("Clipboard unavailable. Select and copy the displayed value manually.")
    }
  }

  return (
    <Card id="domain-verification" className="mb-6 scroll-mt-6 p-4 sm:p-6">
      <h2 className="text-lg font-semibold">Domain verification</h2>
      <p className="mt-2 text-sm">
        {error
          ? "Verification status could not be confirmed."
          : busy
            ? "Checking verification status…"
            : status}
      </p>
      <p className="text-muted-foreground mt-2 text-sm">
        DNS proof confirms domain control, not application security. Self-attestation alone does not
        satisfy paid scan verification.
      </p>
      {!domain ? (
        <p className="mt-2 text-sm">
          This target needs a valid public domain before DNS verification.
        </p>
      ) : !canValidate ? (
        <p className="mt-2 text-sm">
          Ask a workspace member with target validation permission to verify this domain.
        </p>
      ) : (
        <>
          <p className="mt-2 break-all text-sm">Domain: {domain}</p>
          {/* The card used to name two buttons and a policy sentence without
              saying what to do at the DNS provider. The steps are the task. */}
          <ol className="mt-4 space-y-2 text-sm">
            <li>
              <span className="font-medium">1. Get the TXT record.</span> Select{" "}
              <span className="font-medium">Get TXT record</span> below. That issues the proof and
              shows the record name and value.
            </li>
            <li>
              <span className="font-medium">2. Publish it at your DNS provider.</span> Add a TXT
              record with the exact name and value shown, then save it.
            </li>
            <li>
              <span className="font-medium">3. Wait for the record to appear.</span> DNS changes
              usually propagate within minutes, but can take longer.
            </li>
            <li>
              <span className="font-medium">4. Verify.</span> Select{" "}
              <span className="font-medium">Verify domain</span>. LyraShield reads the record from
              public DNS.
            </li>
          </ol>
          <p className="text-muted-foreground mt-3 text-sm">
            Issuing a new proof invalidates the previous token and verified status. The TXT value is
            shown in this browser session only and is never returned by a later read, so keep it
            somewhere safe: if you reload before verifying, issue a new record and replace the old
            one.
          </p>
          {dns && (
            <dl className="mt-4 space-y-3 text-sm">
              {(
                [
                  ["DNS record name", dns.host],
                  ["TXT value", dns.value],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="font-medium">{label}</dt>
                  <dd className="mt-1 flex flex-wrap items-center gap-2">
                    <code className="min-w-0 break-all select-all">{value}</code>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      aria-label={`Copy ${label}`}
                      onClick={() => void copy(label, value)}
                    >
                      Copy {label}
                    </Button>
                  </dd>
                </div>
              ))}
              {proof && (
                <div>
                  <dt>
                    {proof.status === "VERIFIED" ? "Verification expires" : "Challenge expires"}
                  </dt>
                  <dd>{formatDateTimeUtc(proof.expiresAt)}</dd>
                </div>
              )}
            </dl>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => void mutate(true)}>
              {proof ? "Get a new TXT record" : "Get TXT record"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={
                busy ||
                !proof ||
                expired ||
                (proof.method !== undefined && proof.method !== "DNS_TXT")
              }
              onClick={() => void mutate(false)}
            >
              Verify domain
            </Button>
            {error && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setError(null)
                  setBusy(true)
                  setAttempt((value) => value + 1)
                }}
              >
                Retry status
              </Button>
            )}
          </div>
          {/* A disabled primary control with no stated reason reads as broken. */}
          {(!proof || expired) && !busy && (
            <p className="text-muted-foreground mt-2 text-sm">
              {expired
                ? "The challenge expired. Get a new TXT record, publish it, then verify."
                : "Verification is available once a TXT record has been issued and published."}
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive mt-3 text-sm">
          {error}
        </p>
      )}
      <p role="status" aria-live="polite" className="mt-3 text-sm">
        {message}
      </p>
    </Card>
  )
}
