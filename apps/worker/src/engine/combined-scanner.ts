import { logger } from "@lyrashield/logger"
import { readFile, readdir, stat } from "fs/promises"
import { join, extname } from "path"
import type { EngineVulnerability } from "./output-parser"
import {
  type DependencyVulnerability,
  normalizeScaFinding,
  parseScaOutput,
  sortBySeverity,
  deduplicateScaFindings,
} from "./sca-scanner"
import {
  type SecretFinding,
  normalizeSecretFinding,
  parseSecretScanOutput,
  deduplicateSecretFindings,
} from "./secret-scanner"

export interface CombinedScanResult {
  vulnerabilities: EngineVulnerability[]
  scaFindings: DependencyVulnerability[]
  secretFindings: SecretFinding[]
  totalScanned: number
}

const MANIFEST_FILES: Record<string, string> = {
  "package.json": "npm",
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "npm",
  "yarn.lock": "npm",
  "requirements.txt": "pypi",
  "Pipfile": "pypi",
  "Pipfile.lock": "pypi",
  "pyproject.toml": "pypi",
  "poetry.lock": "pypi",
  "pom.xml": "maven",
  "build.gradle": "maven",
  "build.gradle.kts": "maven",
  "go.mod": "go",
  "go.sum": "go",
  "composer.json": "composer",
  "composer.lock": "composer",
  "Gemfile": "gem",
  "Gemfile.lock": "gem",
  "packages.config": "nuget",
  "Cargo.toml": "cargo",
  "Cargo.lock": "cargo",
}

const SECRET_PATTERNS: Array<{
  ruleId: string
  type: string
  pattern: RegExp
  severity: string
}> = [
  { ruleId: "aws-access-key", type: "AWS Access Key ID", pattern: /AKIA[0-9A-Z]{16}/g, severity: "critical" },
  { ruleId: "aws-secret-key", type: "AWS Secret Access Key", pattern: /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi, severity: "critical" },
  { ruleId: "github-pat", type: "GitHub Personal Access Token", pattern: /gh[pousr]_[A-Za-z0-9]{36}/g, severity: "high" },
  { ruleId: "github-oauth", type: "GitHub OAuth Token", pattern: /gho_[A-Za-z0-9]{36}/g, severity: "high" },
  { ruleId: "google-api-key", type: "Google API Key", pattern: /AIza[0-9A-Za-z\-_]{35}/g, severity: "high" },
  { ruleId: "openai-api-key", type: "OpenAI API Key", pattern: /sk-[A-Za-z0-9]{48}/g, severity: "high" },
  { ruleId: "anthropic-api-key", type: "Anthropic API Key", pattern: /sk-ant-[A-Za-z0-9\-_]{95}/g, severity: "high" },
  { ruleId: "stripe-secret-key", type: "Stripe Secret Key", pattern: /sk_live_[A-Za-z0-9]{24,}/g, severity: "critical" },
  { ruleId: "stripe-publishable-key", type: "Stripe Publishable Key", pattern: /pk_live_[A-Za-z0-9]{24,}/g, severity: "medium" },
  { ruleId: "private-key", type: "Private Key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, severity: "critical" },
  { ruleId: "jwt-secret", type: "JWT Secret", pattern: /(?:jwt[_-]?secret|jwt[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9+/=]{32,}["']?/gi, severity: "high" },
  { ruleId: "database-url-with-creds", type: "Database URL with Credentials", pattern: /(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^:\s]+:[^@\s]+@/gi, severity: "critical" },
  { ruleId: "slack-token", type: "Slack Token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, severity: "high" },
  { ruleId: "sendgrid-api-key", type: "SendGrid API Key", pattern: /SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}/g, severity: "high" },
  { ruleId: "brevo-api-key", type: "Brevo API Key", pattern: /xkeysib-[A-Za-z0-9]{64,}/g, severity: "high" },
  { ruleId: "generic-api-key", type: "Generic API Key", pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*["']?[A-Za-z0-9]{32,}["']?/gi, severity: "medium" },
  { ruleId: "generic-secret", type: "Generic Secret", pattern: /(?:secret|password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{8,}["']?/gi, severity: "medium" },
]

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".cache",
  "vendor", "__pycache__", ".venv", "venv", "env", ".env",
  "coverage", ".turbo", ".prisma", "target",
])

const IGNORED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
  ".svg", ".pdf", ".zip", ".tar", ".gz", ".woff", ".woff2",
  ".ttf", ".eot", ".mp4", ".mp3", ".webm", ".lock",
])

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

async function scanDirectoryForSecrets(
  dirPath: string,
  targetId: string,
  basePath = "",
): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = []

  let entries: string[]
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    entries = await readdir(dirPath)
  } catch {
    return findings
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue

    const fullPath = join(dirPath, entry)
    const relativePath = basePath ? `${basePath}/${entry}` : entry

    let s
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      s = await stat(fullPath)
    } catch {
      continue
    }

    if (s.isDirectory()) {
      const subFindings = await scanDirectoryForSecrets(fullPath, targetId, relativePath)
      findings.push(...subFindings)
      continue
    }

    if (s.size > MAX_FILE_SIZE) continue
    if (IGNORED_EXTENSIONS.has(extname(entry))) continue

    let content: string
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      content = await readFile(fullPath, "utf-8")
    } catch {
      continue
    }

    const lines = content.split("\n")
    for (const { ruleId, type, pattern, severity } of SECRET_PATTERNS) {
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]!
        const matches = line.matchAll(pattern)
        for (const match of matches) {
          const matchedText = match[0]
          const redacted = matchedText.length > 12
            ? `${matchedText.slice(0, 6)}...${matchedText.slice(-4)}`
            : "***REDACTED***"

          findings.push({
            type,
            ruleId,
            severity,
            filePath: relativePath,
            startLine: lineIdx + 1,
            matchedText: redacted,
            redactedValue: redacted,
            fingerprint: `${relativePath}:${lineIdx + 1}:${ruleId}`,
            description: `${type} detected in ${relativePath} at line ${lineIdx + 1}`,
            validityCheck: "unknown",
          })
        }
      }
    }
  }

  return findings
}

async function scanManifestFiles(
  dirPath: string,
  basePath = "",
): Promise<{ found: boolean; ecosystems: Set<string> }> {
  let entries: string[]
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    entries = await readdir(dirPath)
  } catch {
    return { found: false, ecosystems: new Set() }
  }

  const ecosystems = new Set<string>()

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue
    if (MANIFEST_FILES[entry]) {
      ecosystems.add(MANIFEST_FILES[entry]!)
    }
    if (extname(entry) === ".csproj") {
      ecosystems.add("nuget")
    }

    const fullPath = join(dirPath, entry)
    let s
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      s = await stat(fullPath)
    } catch {
      continue
    }

    if (s.isDirectory()) {
      const sub = await scanManifestFiles(fullPath, basePath ? `${basePath}/${entry}` : entry)
      sub.ecosystems.forEach((e) => ecosystems.add(e))
    }
  }

  return { found: ecosystems.size > 0, ecosystems }
}

export async function runScaAndSecretScan(
  workDir: string,
  targetId: string,
  scaOutputRaw?: string,
  secretOutputRaw?: string,
): Promise<CombinedScanResult> {
  const allVulnerabilities: EngineVulnerability[] = []
  let scaFindings: DependencyVulnerability[] = []
  let secretFindings: SecretFinding[] = []

  // 1. Parse SCA output if provided (from external tool like OSV-Scanner, npm audit, etc.)
  if (scaOutputRaw) {
    const parsed = parseScaOutput(scaOutputRaw)
    scaFindings = deduplicateScaFindings(sortBySeverity(parsed))
  }

  // 2. Parse secret scan output if provided (from external tool like gitleaks, trufflehog, etc.)
  if (secretOutputRaw) {
    const parsed = parseSecretScanOutput(secretOutputRaw)
    secretFindings = deduplicateSecretFindings(parsed)
  }

  // 3. If no external output, run built-in secret scanner on the work directory
  if (!secretOutputRaw) {
    logger.info("Running built-in secret scanner", { workDir, targetId })
    const builtInSecrets = await scanDirectoryForSecrets(workDir, targetId)
    secretFindings = deduplicateSecretFindings(builtInSecrets)
  }

  // 4. If no external SCA output, check for manifest files
  if (!scaOutputRaw) {
    const { ecosystems } = await scanManifestFiles(workDir)
    if (ecosystems.size > 0) {
      logger.info("Dependency manifests found", { ecosystems: Array.from(ecosystems), targetId })
      // External SCA tool would be invoked here in production
      // For now, we note the ecosystems found
    }
  }

  // 5. Normalize all findings to EngineVulnerability format
  for (const dep of scaFindings) {
    allVulnerabilities.push(normalizeScaFinding(dep, targetId))
  }

  for (const secret of secretFindings) {
    allVulnerabilities.push(normalizeSecretFinding(secret, targetId))
  }

  logger.info("SCA + Secret scan complete", {
    targetId,
    scaFindings: scaFindings.length,
    secretFindings: secretFindings.length,
    totalVulnerabilities: allVulnerabilities.length,
  })

  return {
    vulnerabilities: allVulnerabilities,
    scaFindings,
    secretFindings,
    totalScanned: allVulnerabilities.length,
  }
}
