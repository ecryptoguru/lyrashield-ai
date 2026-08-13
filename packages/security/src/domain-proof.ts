import { domainToASCII } from "node:url"
import net from "node:net"

const DOMAIN_PROOF_PREFIX = "_lyrashield"

/** DNS TXT answers flattened from the resolver's segmented record shape. */
export type TxtResolver = (hostname: string) => Promise<string[][]>

export function normalizeDomainForProof(value: string): string | null {
  let hostname = value.trim()
  try {
    if (hostname.includes("://")) hostname = new URL(hostname).hostname
  } catch {
    return null
  }
  hostname = hostname.toLowerCase().replace(/\.$/, "")
  const normalized = domainToASCII(hostname.normalize("NFKC"))
  if (
    !normalized ||
    normalized.length > 253 ||
    net.isIP(normalized) !== 0 ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    !normalized.includes(".")
  ) {
    return null
  }
  return normalized
}

export function domainProofTxtName(domain: string): string | null {
  const normalized = normalizeDomainForProof(domain)
  return normalized ? `${DOMAIN_PROOF_PREFIX}.${normalized}` : null
}

/** TXT values are public proofs. Constant-time comparison is unnecessary here. */
export function hasDomainProofToken(records: string[][], token: string): boolean {
  return records.some((record) => record.join("") === token)
}

export async function verifyDomainProofToken(
  domain: string,
  token: string,
  resolveTxt: TxtResolver
): Promise<boolean> {
  const txtName = domainProofTxtName(domain)
  if (!txtName || !/^[a-zA-Z0-9_-]{32,256}$/.test(token)) return false
  try {
    return hasDomainProofToken(await resolveTxt(txtName), token)
  } catch {
    return false
  }
}
