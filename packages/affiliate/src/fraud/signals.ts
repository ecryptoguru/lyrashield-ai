/**
 * Fraud signals — disposable-email / proxy-VPN / device-fingerprint flags.
 * Rate-limit signups per IP/device.
 */

export type FraudSignalType =
  | "DISPOSABLE_EMAIL"
  | "PROXY_VPN"
  | "DEVICE_FINGERPRINT_DUPLICATE"
  | "RATE_LIMIT_IP"
  | "RATE_LIMIT_DEVICE"

export interface FraudSignal {
  type: FraudSignalType
  severity: "low" | "medium" | "high"
  detail: string
}

export interface FraudResult {
  flagged: boolean
  signals: FraudSignal[]
  /** Whether to block the action. */
  block: boolean
}

// Common disposable email domains (subset — extend with a full list in production)
const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "tempmail.org",
  "mailinator.com",
  "throwaway.email",
  "temp-mail.org",
  "yopmail.com",
  "getnada.com",
  "dispostable.com",
  "sharklasers.com",
])

/**
 * Detect fraud signals from signup/attribution context.
 */
export function detectFraudSignals(params: {
  email?: string
  ipHash?: string
  userAgent?: string
  deviceFingerprint?: string
  signupCountByIp?: number
  signupCountByDevice?: number
}): FraudResult {
  const signals: FraudSignal[] = []

  // Disposable email check
  if (params.email) {
    const domain = params.email.split("@")[1]?.toLowerCase()
    if (domain && DISPOSABLE_DOMAINS.has(domain)) {
      signals.push({
        type: "DISPOSABLE_EMAIL",
        severity: "medium",
        detail: `Email domain "${domain}" is a known disposable email provider`,
      })
    }
  }

  // Rate limit per IP (more than 5 signups from same IP)
  if (params.signupCountByIp && params.signupCountByIp > 5) {
    signals.push({
      type: "RATE_LIMIT_IP",
      severity: "high",
      detail: `${params.signupCountByIp} signups from same IP`,
    })
  }

  // Rate limit per device (more than 3 signups from same device)
  if (params.signupCountByDevice && params.signupCountByDevice > 3) {
    signals.push({
      type: "RATE_LIMIT_DEVICE",
      severity: "high",
      detail: `${params.signupCountByDevice} signups from same device fingerprint`,
    })
  }

  // Device fingerprint duplicate
  if (params.deviceFingerprint && params.signupCountByDevice && params.signupCountByDevice > 1) {
    signals.push({
      type: "DEVICE_FINGERPRINT_DUPLICATE",
      severity: "medium",
      detail: "Duplicate device fingerprint detected",
    })
  }

  // Proxy/VPN detection would require an external API (e.g. IPQualityScore)
  // This is a placeholder for production integration
  // if (params.ipHash && await checkProxyVPN(params.ipHash)) {
  //   signals.push({ type: "PROXY_VPN", severity: "low", detail: "IP appears to be a proxy/VPN" })
  // }

  const block = signals.some(
    (s) => s.severity === "high" || s.type === "RATE_LIMIT_IP" || s.type === "RATE_LIMIT_DEVICE"
  )

  return {
    flagged: signals.length > 0,
    signals,
    block,
  }
}
