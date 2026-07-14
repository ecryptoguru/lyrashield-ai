import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "./output-parser"

export interface VerificationResult {
  verified: boolean
  confidence: "high" | "medium" | "low"
  reason: string
  verificationMethod: string
}

export interface VerifiedVulnerability extends EngineVulnerability {
  verification: VerificationResult
}

export function verifyVulnerability(vuln: EngineVulnerability): VerificationResult {
  if (vuln.poc_script_code && vuln.poc_description) {
    return {
      verified: false,
      confidence: "medium",
      reason:
        "Engine-provided PoC requires an independent verification job before it can be trusted",
      verificationMethod: "engine_claim_pending_verification",
    }
  }

  if (vuln.poc_description) {
    return {
      verified: false,
      confidence: "medium",
      reason: "Engine-provided PoC description requires independent verification",
      verificationMethod: "engine_claim_pending_verification",
    }
  }

  if (vuln.code_locations && vuln.code_locations.length > 0) {
    const hasFix = vuln.code_locations.some((loc) => loc.fix_before && loc.fix_after)
    if (hasFix) {
      return {
        verified: false,
        confidence: "medium",
        reason: "Engine-provided code diff requires trusted source checkout verification",
        verificationMethod: "engine_claim_pending_verification",
      }
    }
    return {
      verified: false,
      confidence: "medium",
      reason: "Engine-provided code location requires trusted source checkout verification",
      verificationMethod: "engine_claim_pending_verification",
    }
  }

  if (vuln.technical_analysis && vuln.impact) {
    return {
      verified: false,
      confidence: "medium",
      reason: "Engine-provided analysis requires independent verification",
      verificationMethod: "engine_claim_pending_verification",
    }
  }

  if (vuln.cve || vuln.cwe) {
    return {
      verified: false,
      confidence: "medium",
      reason:
        "CVE/CWE identifier present — vulnerability mapped to known weakness but not verified via PoC or code analysis",
      verificationMethod: "cve_cwe_mapping",
    }
  }

  return {
    verified: false,
    confidence: "low",
    reason:
      "Insufficient evidence for verification — no PoC, code location, or technical analysis provided",
    verificationMethod: "unverified",
  }
}

export function verifyFindings(vulns: EngineVulnerability[]): VerifiedVulnerability[] {
  const results = vulns.map((vuln) => ({
    ...vuln,
    verification: verifyVulnerability(vuln),
  }))

  const verified = results.filter((r) => r.verification.verified).length
  const unverified = results.length - verified
  logger.info("Findings verification complete", { total: results.length, verified, unverified })

  return results
}

export function getConfidenceScore(verification: VerificationResult): number {
  if (!verification.verified) return 0
  if (verification.confidence === "high") return 90
  if (verification.confidence === "medium") return 60
  return 30
}
