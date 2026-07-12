/**
 * SSRF validation for the web app. The implementation now lives in the shared
 * `@lyrashield/security` package so the API (create-time) and the scan worker
 * (fetch-time) enforce identical rules and can never diverge. Re-exported here
 * to preserve existing import paths.
 */
export {
  checkScanUrlSafe,
  isBlockedIp,
  parseIpLiteral,
  canonicalizeIpv4,
  expandIpv6,
  type SsrfReason,
  type SsrfCheckResult,
  type HostResolver,
} from "@lyrashield/security"
