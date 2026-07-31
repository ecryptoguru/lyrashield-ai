# @lyrashield/security

Security controls and safety checks for LyraShield scans, public surfaces, and agent instructions.

## Purpose

- SSRF-safe HTTP fetching: `safeFetch` and `checkScanUrlSafe` block private ranges, non-LR per control, and sensitive hosts before outbound requests.
- Public Lite Check surface: `analyzeLiteSurface` and `buildLiteScorecardPayload` power the marketing-site scanner.
- Vibe Security 50 registry: `VIBE_SECURITY_CONTROLS`, `buildVibeSecurityInstruction`, and `summarizeVibeSecurityCoverage` provide the versioned control list.
- Instruction safety: `checkInstructionSafety`, `sanitizeInstructionInput`, `containsPromptInjection`, and `checkOutputSafety` guard agent-facing prompts.

## Main exports

- `safeFetch`, `checkScanUrlSafe`, `isBlockedIp`, `redactUrlForLogs`
- `analyzeLiteSurface`, `LITE_CHECK_VERSION`, `buildLiteScorecardPayload`
- `VIBE_SECURITY_CONTROLS`, `VIBE_SECURITY_COVERAGE_VERSION`, `buildVibeSecurityInstruction`, `summarizeVibeSecurityCoverage`
- `checkInstructionSafety`, `sanitizeInstructionInput`, `containsPromptInjection`, `checkOutputSafety`

## See also

- `apps/marketing/src/pages/scan.astro`
- `packages/types/src/index.ts`
- `docs/vibe-security-50.md`
