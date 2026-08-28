const APP_HOST = "app.lyrashieldai.com"
const CERTIFICATE_SHA256 = /^[a-f0-9]{64}$/

export type AppOriginTrust = "cloudflare" | "probe" | "off" | "untrusted"

function requestHost(request: Request): string {
  return (request.headers.get("host") ?? new URL(request.url).hostname).split(":")[0]!.toLowerCase()
}

function certificateDer(xfcc: string): Uint8Array | null {
  const certificates = [...xfcc.matchAll(/(?:^|;)\s*Cert="([^"]+)"/gi)]
  if (certificates.length !== 1) return null

  const pem = certificates[0]![1]!.replace(/\\n/g, "\n").replace(/\\r/g, "\r")
  const base64 = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "")
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null

  try {
    const binary = atob(base64)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function certificateSha256(xfcc: string): Promise<string | null> {
  const der = certificateDer(xfcc)
  if (!der) return null
  const digest = await crypto.subtle.digest("SHA-256", der.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function assessAppOrigin(request: Request): Promise<AppOriginTrust> {
  if (requestHost(request) !== APP_HOST) return "off"
  if (process.env.CLOUDFLARE_ORIGIN_MTLS !== "required") return "off"

  const cloudflareFingerprint = process.env.CLOUDFLARE_AOP_CERT_SHA256?.toLowerCase() ?? ""
  const probeFingerprint = process.env.DEPLOY_PROBE_CERT_SHA256?.toLowerCase() ?? ""
  const xfcc = request.headers.get("x-forwarded-client-cert")
  if (
    !CERTIFICATE_SHA256.test(cloudflareFingerprint) ||
    !CERTIFICATE_SHA256.test(probeFingerprint) ||
    !xfcc
  ) {
    return "untrusted"
  }
  const actual = await certificateSha256(xfcc)
  if (actual === cloudflareFingerprint) return "cloudflare"
  if (actual === probeFingerprint) return "probe"
  return "untrusted"
}

export function trustedAppCountry(request: Request): string | null {
  const country = request.headers.get("cf-ipcountry")?.trim().toUpperCase() ?? ""
  return /^[A-Z]{2}$/.test(country) ? country : null
}

export function isAppHost(request: Request): boolean {
  return requestHost(request) === APP_HOST
}
