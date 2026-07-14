/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex, security/detect-non-literal-regexp */
import { lstat, readFile, readdir } from "fs/promises"
import { join, relative } from "path"
import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "../output-parser"

export interface SecretsScanConfig {
  repoPath: string
  workspaceDir: string
  maxFileSize?: number
  signal?: AbortSignal
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Secrets scan cancelled")
}

interface SecretPattern {
  id: string
  name: string
  severity: string
  cwe: string
  pattern: RegExp
  description: string
  falsePositiveHints?: string[]
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: "aws-access-key",
    name: "AWS Access Key ID",
    severity: "critical",
    cwe: "CWE-798",
    pattern: /AKIA[0-9A-Z]{16}/g,
    description: "An AWS Access Key ID was found hardcoded in the source code.",
    falsePositiveHints: ["example", "test", "placeholder", "AKIATEST", "AKIAEXAMPLE"],
  },
  {
    id: "aws-secret-key",
    name: "AWS Secret Access Key",
    severity: "critical",
    cwe: "CWE-798",
    pattern: /aws_secret_access_key\s*[:=]\s*["']([A-Za-z0-9/+=]{40})["']/gi,
    description: "An AWS Secret Access Key was found hardcoded in the source code.",
  },
  {
    id: "github-token",
    name: "GitHub Personal Access Token",
    severity: "critical",
    cwe: "CWE-798",
    pattern: /gh[pousr]_[A-Za-z0-9]{36}/g,
    description: "A GitHub Personal Access Token was found hardcoded in the source code.",
    falsePositiveHints: ["example", "test", "placeholder"],
  },
  {
    id: "github-oauth",
    name: "GitHub OAuth Token",
    severity: "high",
    cwe: "CWE-798",
    pattern: /gho_[A-Za-z0-9]{36}/g,
    description: "A GitHub OAuth Token was found hardcoded in the source code.",
  },
  {
    id: "google-api-key",
    name: "Google API Key",
    severity: "high",
    cwe: "CWE-798",
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
    description: "A Google API Key was found hardcoded in the source code.",
    falsePositiveHints: ["example", "test", "placeholder", "AIzaSyExample"],
  },
  {
    id: "slack-token",
    name: "Slack Bot Token",
    severity: "critical",
    cwe: "CWE-798",
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    description: "A Slack Bot Token was found hardcoded in the source code.",
    falsePositiveHints: ["example", "test", "placeholder"],
  },
  {
    id: "slack-webhook",
    name: "Slack Webhook URL",
    severity: "high",
    cwe: "CWE-798",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/g,
    description: "A Slack Webhook URL was found hardcoded in the source code.",
  },
  {
    id: "stripe-secret",
    name: "Stripe Secret Key",
    severity: "critical",
    cwe: "CWE-798",
    pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/g,
    description: "A Stripe Secret Key was found hardcoded in the source code.",
    falsePositiveHints: ["sk_test_example", "sk_live_example"],
  },
  {
    id: "private-key-pem",
    name: "Private Key (PEM)",
    severity: "critical",
    cwe: "CWE-321",
    pattern: /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+|PGP\s+|ENCRYPTED\s+)?PRIVATE KEY-----/g,
    description: "A PEM-encoded private key was found hardcoded in the source code.",
  },
  {
    id: "jwt-token",
    name: "Hardcoded JWT Token",
    severity: "high",
    cwe: "CWE-798",
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    description: "A JWT token was found hardcoded in the source code.",
    falsePositiveHints: ["example", "test", "demo"],
  },
  {
    id: "database-url",
    name: "Database Connection String with Credentials",
    severity: "high",
    cwe: "CWE-798",
    pattern: /(postgres|postgresql|mongodb|mysql|redis|amqp):\/\/[^:\s]+:[^@\s]+@[^\s/]+/gi,
    description:
      "A database connection string containing embedded credentials was found in the source code.",
    falsePositiveHints: ["localhost", "127.0.0.1", "user:pass", "username:password"],
  },
  {
    id: "generic-api-key",
    name: "Generic API Key Assignment",
    severity: "medium",
    cwe: "CWE-798",
    pattern:
      /(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key)\s*[:=]\s*["']([A-Za-z0-9_\-]{20,})["']/gi,
    description: "A hardcoded API key or secret was found in an assignment statement.",
    falsePositiveHints: ["example", "test", "placeholder", "your_api_key", "xxx", "change_me"],
  },
  {
    id: "password-assignment",
    name: "Hardcoded Password Assignment",
    severity: "medium",
    cwe: "CWE-798",
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']([^"'\s]{6,})["']/gi,
    description: "A hardcoded password was found in an assignment statement.",
    falsePositiveHints: [
      "example",
      "test",
      "placeholder",
      "your_password",
      "changeme",
      "xxx",
      "secret",
    ],
  },
  {
    id: "bearer-token",
    name: "Hardcoded Bearer Token",
    severity: "high",
    cwe: "CWE-798",
    pattern: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/g,
    description: "A hardcoded Bearer token was found in the source code.",
    falsePositiveHints: ["example", "test", "placeholder", "your_token"],
  },
  {
    id: "discord-webhook",
    name: "Discord Webhook URL",
    severity: "medium",
    cwe: "CWE-798",
    pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
    description: "A Discord Webhook URL was found hardcoded in the source code.",
  },
  {
    id: "twilio-token",
    name: "Twilio Auth Token",
    severity: "high",
    cwe: "CWE-798",
    pattern: /SK[0-9a-fA-F]{32}/g,
    description: "A Twilio Auth Token was found hardcoded in the source code.",
  },
]

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  "vendor",
  "__pycache__",
  ".pytest_cache",
  ".turbo",
])

const IGNORED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".lock",
  ".sum",
])

const MAX_FILE_SIZE = 512 * 1024
const MAX_WALK_ENTRIES = 50_000
const MAX_WALK_DEPTH = 40
const MAX_FINDINGS_PER_FILE = 200

async function walkDir(
  dir: string,
  basePath: string,
  files: string[],
  state = { entries: 0 },
  depth = 0,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  if (depth > MAX_WALK_DEPTH || state.entries >= MAX_WALK_ENTRIES) return
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    throwIfAborted(signal)
    if (++state.entries > MAX_WALK_ENTRIES) break
    const fullPath = join(dir, entry)
    let s
    try {
      s = await lstat(fullPath)
    } catch {
      continue
    }

    if (s.isSymbolicLink()) continue

    if (s.isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) {
        await walkDir(fullPath, basePath, files, state, depth + 1, signal)
      }
    } else if (s.isFile() && s.size <= MAX_FILE_SIZE) {
      const ext = entry.substring(entry.lastIndexOf("."))
      if (!IGNORED_EXTENSIONS.has(ext)) {
        files.push(fullPath)
      }
    }
  }
}

function isFalsePositive(match: string, pattern: SecretPattern): boolean {
  if (!pattern.falsePositiveHints) return false
  const lowerMatch = match.toLowerCase()
  return pattern.falsePositiveHints.some((hint) => lowerMatch.includes(hint.toLowerCase()))
}

function isTestFixturePath(relativePath: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|fixtures?|e2e)(?:\/|$)/i.test(relativePath) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(relativePath) ||
    /(?:^|\/)(?:test|tests?)\.(?:md|txt)$/i.test(relativePath)
  )
}

function isComposeEnvironmentTemplate(
  relativePath: string,
  match: string,
  pattern: SecretPattern
): boolean {
  return (
    pattern.id === "database-url" &&
    /(?:^|\/)docker-compose(?:\.[^/]+)?\.ya?ml$/i.test(relativePath) &&
    match.includes("${")
  )
}

function getFileExtension(filePath: string): string {
  return filePath.substring(filePath.lastIndexOf("."))
}

function getLanguageFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".java": "Java",
    ".rb": "Ruby",
    ".php": "PHP",
    ".sh": "Shell",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".json": "JSON",
    ".xml": "XML",
    ".env": "Environment",
    ".toml": "TOML",
    ".cfg": "Config",
    ".ini": "Config",
    ".conf": "Config",
  }
  return map[ext] ?? "Unknown"
}

export async function scanSecrets(config: SecretsScanConfig): Promise<EngineVulnerability[]> {
  const { repoPath, workspaceDir, signal } = config
  throwIfAborted(signal)
  logger.info("Starting secrets scan", { repoPath })

  const files: string[] = []
  await walkDir(repoPath, repoPath, files, { entries: 0 }, 0, signal)

  logger.info("Files to scan", { total: files.length })

  const findings: EngineVulnerability[] = []
  const seenFindings = new Set<string>()

  for (const filePath of files) {
    throwIfAborted(signal)
    let content: string
    try {
      content = await readFile(filePath, "utf-8")
    } catch {
      continue
    }

    const relPath = relative(workspaceDir, filePath)
    const ext = getFileExtension(filePath)
    const language = getLanguageFromExt(ext)
    let findingsInFile = 0

    // Test vectors and test-only examples deliberately contain credential-shaped
    // strings. They prove scanner detection but are not deployable secrets.
    if (isTestFixturePath(relPath)) continue

    for (const pattern of SECRET_PATTERNS) {
      throwIfAborted(signal)
      const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags)
      let match: RegExpExecArray | null
      while (findingsInFile < MAX_FINDINGS_PER_FILE && (match = regex.exec(content)) !== null) {
        throwIfAborted(signal)
        const matchedText = match[0]
        const lineNum = content.substring(0, match.index).split("\n").length

        if (
          isFalsePositive(matchedText, pattern) ||
          isComposeEnvironmentTemplate(relPath, matchedText, pattern)
        ) {
          continue
        }

        const findingId = `${pattern.id}-${relPath}-${lineNum}`
        if (seenFindings.has(findingId)) continue
        seenFindings.add(findingId)
        findingsInFile++

        const redactedMatch =
          matchedText.substring(0, 8) + "..." + matchedText.substring(matchedText.length - 4)

        findings.push({
          id: findingId,
          title: `${pattern.name} in ${relPath}:${lineNum}`,
          severity: pattern.severity,
          timestamp: new Date().toISOString(),
          target: relPath,
          cwe: pattern.cwe,
          description: pattern.description,
          technical_analysis: `A ${pattern.name} was detected in ${relPath} at line ${lineNum}. The pattern matched: ${redactedMatch}. File type: ${language}.`,
          impact: `Hardcoded secrets can be extracted from source code, git history, or built artifacts. An attacker with access to this code can use the secret to access the associated service (AWS, GitHub, database, etc.) and potentially escalate to full system compromise.`,
          remediation_steps: `Remove the hardcoded secret from ${relPath}. Move it to an environment variable or a secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault). Rotate the exposed secret immediately — it should be considered compromised.`,
          poc_description: `Read line ${lineNum} of ${relPath} to find the hardcoded ${pattern.name}. The matched value has been redacted for security.`,
          code_locations: [
            {
              file: relPath,
              start_line: lineNum,
              label: pattern.name,
              snippet: `[REDACTED: ${pattern.name} detected on this line]`,
            },
          ],
        })
      }
    }
  }

  logger.info("Secrets scan complete", {
    repoPath,
    findingCount: findings.length,
    filesScanned: files.length,
  })
  return findings
}
