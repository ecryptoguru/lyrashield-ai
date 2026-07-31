import { execFile } from "node:child_process"
import process from "node:process"

export interface DiffFinding {
  ruleId: string
  level: "error" | "warning" | "note"
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  message: string
  file?: string
  line?: number
}

const RISKY_PATTERNS: {
  ruleId: string
  severity: DiffFinding["severity"]
  regex: RegExp
  message: (file: string) => string
}[] = [
  {
    ruleId: "hardcoded-secret",
    severity: "MEDIUM",
    regex: /(password|secret|api_key|apikey|token)\s*[=:]\s*["'][^"']{8,}["']/i,
    message: (file) => `Potential hardcoded secret in ${file}`,
  },
  {
    ruleId: "sql-injection",
    severity: "MEDIUM",
    regex: /(SELECT|INSERT|UPDATE|DELETE).*\+.*\$\{/i,
    message: (file) => `Potential SQL injection in ${file}`,
  },
  {
    ruleId: "disabled-security-control",
    severity: "MEDIUM",
    regex: /(csrf|cors|xss|helmet|secure)\s*[:=]\s*(false|disabled|off|none)/i,
    message: (file) => `Security control may be disabled in ${file}`,
  },
  {
    ruleId: "eval-exec",
    severity: "MEDIUM",
    regex: /(^|[^.\w])(eval|exec)\s*\(/i,
    message: (file) => `Use of eval/exec in ${file}`,
  },
]

export function rankSeverity(s: string): number {
  switch (s.toUpperCase()) {
    case "CRITICAL":
      return 5
    case "HIGH":
      return 4
    case "MEDIUM":
      return 3
    case "LOW":
      return 2
    case "INFO":
      return 1
    default:
      return 0
  }
}

export function resolveDiffRange(
  staged: boolean,
  base?: string,
  head?: string
): { base: string; head: string } {
  if (staged) {
    return { base: "HEAD", head: "--cached" }
  }
  const b = base ?? "HEAD~1"
  const h = head ?? "HEAD"
  return { base: b, head: h }
}

export async function getChangedFiles(base: string, head: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("git", ["diff", "--name-only", base, head], { cwd: process.cwd() }, (err, stdout) => {
      if (err) return reject(err)
      resolve(
        stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      )
    })
  })
}

export async function getAddedLinesForFile(
  base: string,
  head: string,
  file: string
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--unified=0", base, head, "--", file],
      { cwd: process.cwd() },
      (err, stdout) => {
        if (err) return reject(err)
        const lines = stdout
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++") && !l.startsWith("+//"))
          .map((l) => l.slice(1))
        resolve(lines)
      }
    )
  })
}

export async function runRiskyPatternChecks(base: string, head: string): Promise<DiffFinding[]> {
  const files = await getChangedFiles(base, head)
  const findings: DiffFinding[] = []
  for (const file of files) {
    const added = await getAddedLinesForFile(base, head, file)
    const text = added.join("\n")
    for (const pattern of RISKY_PATTERNS) {
      if (pattern.regex.test(text)) {
        findings.push({
          ruleId: pattern.ruleId,
          level:
            pattern.severity === "HIGH" || pattern.severity === "CRITICAL" ? "error" : "warning",
          severity: pattern.severity,
          message: pattern.message(file),
          file,
        })
      }
    }
  }
  return findings
}

export interface SarifResult {
  ruleId: string
  level: string
  message: { text: string }
  locations?: { physicalLocation: { artifactLocation: { uri: string } } }[]
}

export function buildSarif(results: SarifResult[]): unknown {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "lyrashield",
            version: "0.1.0",
            informationUri: "https://github.com/ecryptoguru/lyrashield-ai",
          },
        },
        results,
      },
    ],
  }
}
