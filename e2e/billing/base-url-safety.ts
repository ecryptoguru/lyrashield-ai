const PRODUCTION_HOSTS = new Set([
  "lyrashieldai.com",
  "app.lyrashieldai.com",
  "lyrashield-app.icyglacier-d3526777.centralindia.azurecontainerapps.io",
  "lyrashield-scanner.icyglacier-d3526777.centralindia.azurecontainerapps.io",
])

export function assertSafeBillingE2EBaseUrl(
  baseURL: string,
  expectedBaseHost: string | undefined,
  remote: boolean
): void {
  const hostname = new URL(baseURL).hostname.toLowerCase()
  const expectedHost = expectedBaseHost?.trim().toLowerCase()
  if (PRODUCTION_HOSTS.has(hostname)) {
    throw new Error("Billing E2E proof must never target a production LyraShield AI origin")
  }
  if (!expectedHost || hostname !== expectedHost) {
    throw new Error("BILLING_E2E_EXPECTED_BASE_HOST must exactly match the billing E2E origin")
  }
  if (remote && !/(^|[.-])stag(?:e|ing)([.-]|$)/i.test(hostname)) {
    throw new Error("Remote billing E2E origin must carry an explicit staging marker")
  }
}
