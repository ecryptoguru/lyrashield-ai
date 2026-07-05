import { createHash } from "crypto"
import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "./output-parser"

export interface SecretFinding {
  type: string
  ruleId: string
  severity: string
  filePath: string
  startLine: number
  endLine?: number
  startColumn?: number
  endColumn?: number
  matchedText: string
  redactedValue: string
  fingerprint: string
  description?: string
  remediation?: string
  isVerified?: boolean
  validityCheck?: "valid" | "invalid" | "unknown"
}

export interface SecretScanResult {
  findings: SecretFinding[]
  totalScanned: number
  secretCount: number
  filesScanned: number
}

const SECRET_SEVERITY_MAP: Record<string, string> = {
  "aws-access-key": "critical",
  "aws-secret-key": "critical",
  "github-pat": "high",
  "github-oauth": "high",
  "google-api-key": "high",
  "google-oauth-client-secret": "high",
  "openai-api-key": "high",
  "anthropic-api-key": "high",
  "stripe-secret-key": "critical",
  "stripe-publishable-key": "medium",
  "private-key": "critical",
  "jwt-secret": "high",
  "database-url-with-creds": "critical",
  "generic-api-key": "medium",
  "generic-secret": "medium",
  "slack-token": "high",
  "twilio-api-key": "high",
  "sendgrid-api-key": "high",
  "brevo-api-key": "high",
  "polar-access-token": "high",
  "razorpay-key-secret": "high",
}

const REMEDIATION_MAP: Record<string, string> = {
  "aws-access-key": "Rotate the AWS access key in the IAM console. Replace with environment variables or a secrets manager. Audit CloudTrail for unauthorized use.",
  "aws-secret-key": "Rotate the AWS secret key immediately. Replace with environment variables or a secrets manager. Audit CloudTrail for unauthorized use.",
  "github-pat": "Revoke the GitHub personal access token in Settings → Developer settings → Personal access tokens. Use GitHub Apps or OIDC instead.",
  "github-oauth": "Revoke the OAuth token in GitHub Settings → Applications. Re-generate through the proper OAuth flow.",
  "google-api-key": "Restrict the API key in Google Cloud Console. If compromised, rotate it. Use service accounts with minimal permissions.",
  "private-key": "Rotate the private key immediately. Replace with a new key pair. Audit all systems that used the compromised key.",
  "stripe-secret-key": "Roll the Stripe secret key in the Dashboard. Use restricted keys with minimal scopes. Set up Stripe webhook signature verification.",
  "openai-api-key": "Revoke the OpenAI API key in platform.openai.com → API keys. Generate a new one and store it in a secrets manager.",
  "anthropic-api-key": "Revoke the Anthropic API key in console.anthropic.com. Generate a new one and store it in a secrets manager.",
  "database-url-with-creds": "Rotate the database credentials. Use connection pooling with separate auth. Store the URL in environment variables only.",
  "jwt-secret": "Rotate the JWT signing secret. This will invalidate all existing tokens — coordinate with users. Use a key rotation strategy.",
  "slack-token": "Revoke the Slack token in api.slack.com → Apps. Use OAuth bot tokens with minimal scopes instead.",
}

export function normalizeSecretFinding(
  secret: SecretFinding,
  targetId: string,
): EngineVulnerability {
  const severity = SECRET_SEVERITY_MAP[secret.ruleId] ?? secret.severity ?? "medium"
  const title = `Exposed secret: ${secret.type} in ${secret.filePath}`

  return {
    id: createHash("sha256")
      .update(`${targetId}|secret|${secret.filePath}|${secret.startLine}|${secret.fingerprint}`)
      .digest("hex")
      .slice(0, 32),
    title,
    severity,
    timestamp: new Date().toISOString(),
    target: secret.filePath,
    cwe: "CWE-798", // Use of Hard-coded Credentials
    description: secret.description ?? `A ${secret.type} was detected in ${secret.filePath} at line ${secret.startLine}`,
    impact: `An exposed ${secret.type} could allow unauthorized access to your systems, data, or third-party services. ${secret.validityCheck === "valid" ? "The secret has been verified as active." : ""}`,
    technical_analysis: `Rule: ${secret.ruleId}\nFile: ${secret.filePath}:${secret.startLine}${secret.endLine ? `-${secret.endLine}` : ""}\nMatched pattern: ${secret.redactedValue}\nValidity: ${secret.validityCheck ?? "unknown"}`,
    poc_description: `The secret was found in plaintext at ${secret.filePath}:${secret.startLine}. The redacted value is: ${secret.redactedValue}`,
    remediation_steps: secret.remediation ?? REMEDIATION_MAP[secret.ruleId] ?? `Remove the secret from the file and rotate it immediately. Store secrets in environment variables or a secrets manager. Add the file pattern to .gitignore if appropriate.`,
    code_locations: [
      {
        file: secret.filePath,
        start_line: secret.startLine,
        end_line: secret.endLine,
        label: `Secret: ${secret.type}`,
      },
    ],
  }
}

export function parseSecretScanOutput(raw: string): SecretFinding[] {
  if (!raw.trim()) return []

  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) {
      logger.warn("Secret scan output is not an array", { type: typeof data })
      return []
    }

    return data.filter(
      (s): s is SecretFinding =>
        typeof s === "object" &&
        s !== null &&
        typeof s.ruleId === "string" &&
        typeof s.filePath === "string",
    )
  } catch (err) {
    logger.error("Failed to parse secret scan output", {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

export function redactSecretValue(value: string): string {
  if (value.length <= 8) return "***REDACTED***"
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

export function generateSecretFingerprint(
  filePath: string,
  startLine: number,
  ruleId: string,
): string {
  return createHash("sha256")
    .update(`${filePath}:${startLine}:${ruleId}`)
    .digest("hex")
    .slice(0, 16)
}

export function deduplicateSecretFindings(findings: SecretFinding[]): SecretFinding[] {
  const seen = new Set<string>()
  const result: SecretFinding[] = []

  for (const f of findings) {
    const key = f.fingerprint || generateSecretFingerprint(f.filePath, f.startLine, f.ruleId)
    if (!seen.has(key)) {
      seen.add(key)
      result.push(f)
    }
  }

  return result
}
