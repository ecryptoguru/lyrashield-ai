import { formatDateTimeUtc } from "./date-format"

/** Convert the internal ISO expiry summary into a concise, explicit UTC label. */
export function formatTargetDomainStatus(status: string): string {
  const verifiedUntil = /^Verified until (.+)$/.exec(status)?.[1]
  if (!verifiedUntil) return status
  const timestamp = Date.parse(verifiedUntil)
  return Number.isFinite(timestamp) ? `Verified until ${formatDateTimeUtc(timestamp)}` : status
}
