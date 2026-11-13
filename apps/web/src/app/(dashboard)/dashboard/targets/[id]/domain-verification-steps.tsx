"use client"

import { Button } from "@lyrashield/ui"
import { formatDateTimeUtc } from "@/lib/date-format"

/**
 * The four DNS steps and the record table for domain verification. They were the
 * instructions block inside DomainVerificationContent and moved here unchanged
 * so that component stays inside the size ratchet. Same steps, same order, same
 * markup — the copy was added by this PR and is not altered here.
 */
export function DomainVerificationSteps() {
  return (
    <ol className="mt-4 space-y-2 text-sm">
      <li>
        <span className="font-medium">1. Get the TXT record.</span> Select{" "}
        <span className="font-medium">Get TXT record</span> below. That issues the proof and shows
        the record name and value.
      </li>
      <li>
        <span className="font-medium">2. Publish it at your DNS provider.</span> Add a TXT record
        with the exact name and value shown, then save it.
      </li>
      <li>
        <span className="font-medium">3. Wait for the record to appear.</span> DNS changes usually
        propagate within minutes, but can take longer.
      </li>
      <li>
        <span className="font-medium">4. Verify.</span> Select{" "}
        <span className="font-medium">Verify domain</span>. LyraShield reads the record from public
        DNS.
      </li>
    </ol>
  )
}

export function DomainVerificationRecords({
  dns,
  proofExpiresAt,
  proofStatus,
  onCopy,
}: {
  dns: { host: string; value: string }
  proofExpiresAt: string | null
  proofStatus: string | null
  onCopy: (label: string, value: string) => void
}) {
  return (
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
              onClick={() => onCopy(label, value)}
            >
              Copy {label}
            </Button>
          </dd>
        </div>
      ))}
      {proofExpiresAt && (
        <div>
          <dt>{proofStatus === "VERIFIED" ? "Verification expires" : "Challenge expires"}</dt>
          <dd>{formatDateTimeUtc(proofExpiresAt)}</dd>
        </div>
      )}
    </dl>
  )
}
