"use client"

import { Button, Card } from "@lyrashield/ui"
import { DomainVerificationRecords, DomainVerificationSteps } from "./domain-verification-steps"
import { useDomainVerificationState } from "./domain-verification-state"

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
  const {
    proof,
    dns,
    busy,
    error,
    message,
    expired,
    status,
    issueRecord,
    verifyRecord,
    retryStatus,
    copy,
  } = useDomainVerificationState({ workspaceId, domain, canValidate, initialStatus })

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
          <DomainVerificationSteps />
          <p className="text-muted-foreground mt-3 text-sm">
            Issuing a new proof invalidates the previous token and verified status. The TXT value is
            shown in this browser session only and is never returned by a later read, so keep it
            somewhere safe: if you reload before verifying, issue a new record and replace the old
            one.
          </p>
          {dns && (
            <DomainVerificationRecords
              dns={dns}
              proofExpiresAt={proof?.expiresAt ?? null}
              proofStatus={proof?.status ?? null}
              onCopy={(label, value) => void copy(label, value)}
            />
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={issueRecord}>
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
              onClick={verifyRecord}
            >
              Verify domain
            </Button>
            {error && (
              <Button type="button" variant="secondary" disabled={busy} onClick={retryStatus}>
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
