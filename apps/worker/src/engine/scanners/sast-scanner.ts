// security-scan-skip-file: detection rules reference dangerous patterns by design
/* eslint-disable security/detect-non-literal-fs-filename, security/detect-non-literal-regexp */
import { lstat, readFile, readdir } from "fs/promises"
import { join, relative } from "path"
import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "../output-parser"
import {
  recordCoverageIssue,
  type ScannerCoverageIssue,
  type ScannerDiscovery,
} from "../scanner-coverage"

export interface SastScanConfig {
  repoPath: string
  workspaceDir: string
  signal?: AbortSignal
  coverageIssues?: ScannerCoverageIssue[]
  /** Scan tier — drives the file budget so receipts reflect the mode honestly. */
  mode?: string
  discovery?: ScannerDiscovery
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("SAST scan cancelled")
}

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".php",
  ".rb",
  ".cs",
])

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
  "venv",
  ".venv",
  "target",
  "bin",
  "obj",
])

const MAX_FILE_SIZE = 512 * 1024
const MAX_WALK_ENTRIES = 50_000
const MAX_WALK_DEPTH = 40
const MAX_FINDINGS_PER_FILE = 100
const MAX_TOTAL_FINDINGS = 5_000
// Matches ai-app-security's per-mode file budgets so mode breadth is honest
// across deterministic source families.
const MAX_FILES_BY_MODE = { QUICK: 200, STANDARD: 500, DEEP: 1_000 } as const
const MAX_REPRESENTATIVE_SKIPPED_PATHS = 20

function sastFileBudget(mode: string | undefined): number {
  const key = (mode ?? "STANDARD").toUpperCase() as keyof typeof MAX_FILES_BY_MODE
  return MAX_FILES_BY_MODE[key] ?? MAX_FILES_BY_MODE.STANDARD
}

/** Password-handling context — the only context where a weak hash evidences
 *  control 10 (unsafe password storage). */
const PASSWORD_CONTEXT = /pass(?:word|wd|phrase)?|pwd|credential/i

/** Strong secret-generation context — upgrades insecure randomness to high. */
const STRONG_SECRET_CONTEXT =
  /token|secret|session|csrf|nonce|\botp\b|salt|api[_-]?key|jwt|reset[_-]?code|private[_-]?key|password|credential/i

/** Any security-relevant context — the minimum bar for reporting a noisy
 *  class like insecure randomness. */
const SECURITY_CONTEXT = new RegExp(
  `(?:${PASSWORD_CONTEXT.source}|${STRONG_SECRET_CONTEXT.source}|signature|auth)`,
  "i"
)

/** Contexts where a weak hash is used for integrity/caching, not security. */
const NON_SECURITY_HASH_CONTEXT =
  /etag|checksum|integrity|fingerprint|content[_-]?hash|cache[_-]?key|dedup|idempotenc/i

interface SastRule {
  id: string
  name: string
  severity: "high" | "medium"
  cwe: string
  pattern: RegExp
  description: string
  impact: string
  remediation: string
  /** vibe-security control ranks this rule evidences when its control context
   *  applies (password context for weak hashes; always otherwise). */
  controlIds?: number[]
  /** Control context regex; controlIds apply only when this matches the line. */
  controlContext?: RegExp
  /** Emit the finding only when the line matches a security context. */
  requiresSecurityContext?: boolean
  /** Regex upgrading severity to high when matched. */
  strongContext?: RegExp
  /** Substrings that mark the match as non-security use (skipped). */
  falsePositiveHints?: string[]
  /** Per-file veto: return true to skip this rule's matches for the file. */
  fileVeto?: (content: string) => boolean
}

const SAST_RULES: SastRule[] = [
  {
    id: "weak-hash-md5",
    name: "MD5 used for hashing",
    severity: "medium",
    cwe: "CWE-328",
    pattern:
      /createHash\s*\(\s*["'`]md5|hashlib\.md5\s*\(|MessageDigest\.getInstance\s*\(\s*"md5|\bmd5\.New\s*\(|CryptoJS\.MD5|Digest::MD5|MD5\.Create\s*\(|openssl_digest\s*\([^)]*["']md5|md5\s*\(\s*\$|\bMD5\(|\bmd5\.sum/i,
    description:
      "MD5 is a broken hash: collisions are cheap and it is unsuitable for passwords, signatures, or integrity checks.",
    impact:
      "If MD5 protects passwords, tokens, or signatures, an attacker can reverse or forge values. Rainbow tables and GPU cracking make MD5-hashed passwords effectively plaintext.",
    remediation:
      "Use a password KDF (argon2id, bcrypt, scrypt) for passwords and SHA-256 or stronger for non-security hashing. For signatures use HMAC-SHA-256 or better.",
    controlIds: [10],
    controlContext: PASSWORD_CONTEXT,
    strongContext: PASSWORD_CONTEXT,
    falsePositiveHints: ["etag", "checksum", "fingerprint", "content-md5"],
  },
  {
    id: "weak-hash-sha1",
    name: "SHA-1 used for hashing",
    severity: "medium",
    cwe: "CWE-328",
    pattern:
      /createHash\s*\(\s*["'`]sha-?1|hashlib\.sha1\s*\(|MessageDigest\.getInstance\s*\(\s*"sha-?1|\bsha1\.New\s*\(|CryptoJS\.SHA1|Digest::SHA1|SHA1\.Create\s*\(|openssl_digest\s*\([^)]*["']sha1|sha1\s*\(\s*\$|\bSHA1\(|\bsha1\.sum/i,
    description:
      "SHA-1 is collision-broken (SHAttered) and unsuitable for passwords, signatures, or new integrity checks.",
    impact:
      "SHA-1 in a security path (password storage, token signing, certificate validation) can be forged or cracked with modest resources.",
    remediation:
      "Use a password KDF (argon2id, bcrypt, scrypt) for passwords and SHA-256 or stronger elsewhere. Replace SHA-1 signatures with SHA-256+.",
    controlIds: [10],
    controlContext: PASSWORD_CONTEXT,
    strongContext: PASSWORD_CONTEXT,
    falsePositiveHints: ["etag", "checksum", "fingerprint", "content-hash", "git"],
  },
  {
    id: "insecure-random",
    name: "Non-cryptographic randomness in a security-relevant path",
    severity: "medium",
    cwe: "CWE-338",
    pattern:
      /Math\.random\s*\(|random\.(?:random|randint|choice|randrange|getrandbits|uniform|shuffle|sample)\s*\(|new\s+(?:java\.util\.)?Random\s*\(|\brand\.(?:Intn|Int31n|Int63n|Float64|Perm|Shuffle|Read)\s*\(|\bmt_rand\s*\(|\brand\s*\(\s*\d|Random\.rand\s*\(|SecureRandom\s*\(\s*["']SHA1PRNG/i,
    description:
      "A predictable PRNG (Math.random, Python random, math/rand, java.util.Random, mt_rand) appears in a security-relevant context. These generators are seeded predictably and their output can be reconstructed.",
    impact:
      "Predictable randomness in tokens, session ids, CSRF values, OTPs, or password-reset codes lets an attacker guess or reconstruct secrets and take over accounts or flows.",
    remediation:
      "Use a CSPRNG: crypto.randomBytes / crypto.getRandomValues (Node/Web), secrets module (Python), crypto/rand (Go), SecureRandom (Java), random_bytes (PHP).",
    requiresSecurityContext: true,
    strongContext: STRONG_SECRET_CONTEXT,
    falsePositiveHints: ["animation", "shuffle", "game", "mock", "sample only"],
    fileVeto: (content) =>
      // Go: crypto/rand and math/rand share the `rand.` selector. If the file
      // imports crypto/rand and not math/rand, rand.* calls are the CSPRNG.
      /["']crypto\/rand["']/.test(content) && !/["']math\/rand["']/.test(content),
  },
  {
    id: "ecb-mode",
    name: "AES in ECB mode",
    severity: "high",
    cwe: "CWE-327",
    pattern:
      /\bMODE_ECB\b|["'`]aes-(?:128|192|256)-ecb["'`]|["'`]AES\/ECB\/|CryptoJS\.mode\.ECB|\bECBMode|electronic[\s_-]?code[\s_-]?book/i,
    description:
      "ECB mode encrypts identical plaintext blocks to identical ciphertext blocks, leaking structure and enabling block replay/splicing.",
    impact:
      "Encrypted data reveals patterns (the classic ECB penguin) and attackers can reorder or substitute blocks without detection.",
    remediation:
      "Use AEAD modes: AES-GCM or ChaCha20-Poly1305. Never ECB, even for 'small' values.",
  },
  {
    id: "legacy-cipher",
    name: "Legacy cipher (DES/RC4/Blowfish)",
    severity: "medium",
    cwe: "CWE-327",
    pattern:
      /createCipher(?:iv)?\s*\(\s*["'`](?:des|rc4|rc2|bf|blowfish)|CryptoJS\.(?:DES|RC4|Rabbit)\b|\bdes\.NewCipher\s*\(|\brc4\.NewCipher\s*\(|Cipher\.getInstance\s*\(\s*"DES|DESCryptoServiceProvider|openssl_encrypt\s*\([^)]*["'](?:des|rc4|bf-)|MCrypt/i,
    description:
      "DES, RC4, RC2, and Blowfish are deprecated ciphers with known practical attacks and small key spaces.",
    impact:
      "Data encrypted with legacy ciphers can be decrypted by modern attacks (brute force for DES, biases for RC4).",
    remediation:
      "Migrate to AES-GCM or ChaCha20-Poly1305 and rotate any data encrypted under the legacy cipher.",
  },
  {
    id: "verification-disabled",
    name: "TLS/certificate or signature verification disabled",
    severity: "high",
    cwe: "CWE-295",
    pattern:
      /\bverify\s*=\s*False\b|check_hostname\s*=\s*False|CERT_NONE|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:0|false)|verify_peer["']?\s*(?:=>|:)\s*false|X509TrustManager|verify_signature\s*=\s*False/i,
    description:
      "Certificate, hostname, or signature verification is explicitly disabled, defeating the guarantee TLS or signed tokens provide.",
    impact:
      "Disabling verification enables man-in-the-middle interception of traffic or acceptance of forged tokens/signatures.",
    remediation:
      "Remove the bypass. Pin or configure proper CA trust for internal services; never disable verification in shipped code.",
    controlIds: [29],
  },
  {
    id: "jwt-alg-none",
    name: "JWT 'none' algorithm accepted",
    severity: "high",
    cwe: "CWE-347",
    pattern:
      /["']alg["']\s*:\s*["']none["']|algorithms\s*:\s*\[[^\]]*["']none["']|\bheader\s*=\s*\{[^}]*alg[^}]*none/i,
    description:
      "The JWT 'none' algorithm is accepted, allowing unsigned tokens when the verifier honors it.",
    impact: "An attacker can mint an arbitrary unsigned JWT and impersonate any user or role.",
    remediation:
      "Pin an explicit algorithm allowlist (e.g. RS256/EdDSA) and reject 'none' at verification.",
  },
  {
    id: "static-iv",
    name: "Static or hardcoded encryption IV",
    severity: "medium",
    cwe: "CWE-329",
    pattern:
      /createCipheriv\s*\(\s*["'`][^"'`]+["'`]\s*,\s*["'`][0-9a-fA-F]{16,}["'`]\s*,\s*["'`][0-9a-fA-F]{16,}["'`]\s*\)|\biv\s*[:=]\s*["'`](?:0{16,}|1234567890123456)["'`]|InitializationVector\s*\(\s*new\s+byte\s*\[\s*\d+\s*\]/i,
    description:
      "A constant IV/nonce makes encryption deterministic: identical plaintexts produce identical ciphertexts and enable pattern analysis and replay.",
    impact:
      "Static IVs break semantic security; attackers can correlate encrypted records and replay captured ciphertexts.",
    remediation:
      "Generate a fresh random IV per message (crypto.randomBytes) and prepend it to the ciphertext.",
  },
]

function isTestFixturePath(relativePath: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|fixtures?|e2e|testdata|mocks?)(?:\/|$)/i.test(relativePath) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(relativePath)
  )
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed === "" ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("--")
  )
}

async function walkDir(
  dir: string,
  files: string[],
  state = { entries: 0, bounded: false, oversizedFiles: 0 },
  depth = 0,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  if (depth > MAX_WALK_DEPTH || state.entries >= MAX_WALK_ENTRIES) {
    state.bounded = true
    return
  }
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    throwIfAborted(signal)
    if (++state.entries > MAX_WALK_ENTRIES) {
      state.bounded = true
      break
    }
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
        await walkDir(fullPath, files, state, depth + 1, signal)
      }
    } else if (s.isFile()) {
      const ext = entry.substring(entry.lastIndexOf("."))
      if (!SOURCE_EXTENSIONS.has(ext)) continue
      if (s.size <= MAX_FILE_SIZE) {
        files.push(fullPath)
      } else {
        state.oversizedFiles++
      }
    }
  }
}

export async function scanSast(config: SastScanConfig): Promise<EngineVulnerability[]> {
  const { repoPath, workspaceDir, signal, coverageIssues, mode, discovery } = config
  throwIfAborted(signal)
  logger.info("Starting SAST scan", { repoPath })

  const discovered: string[] = []
  const walkState = { entries: 0, bounded: false, oversizedFiles: 0 }
  await walkDir(repoPath, discovered, walkState, 0, signal)
  if (walkState.bounded) {
    recordCoverageIssue(coverageIssues, {
      scanner: "sast",
      status: "bounded",
      reason: "SAST file discovery reached its bounded repository walk limit",
    })
  }
  if (walkState.oversizedFiles > 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "sast",
      status: "bounded",
      subject: `${walkState.oversizedFiles} file(s)`,
      reason: `Files exceeding the ${MAX_FILE_SIZE}-byte scanner limit were not inspected`,
    })
  }

  // Per-mode file budget — deterministic order so repeat runs are identical.
  const maxFiles = sastFileBudget(mode)
  const ordered = [...discovered].sort()
  const files = ordered.slice(0, maxFiles)
  const skippedPaths = ordered.slice(maxFiles)
  if (skippedPaths.length > 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "sast",
      status: "bounded",
      reason: `SAST scanned ${files.length} of ${ordered.length} eligible files; ${skippedPaths.length} exceeded the ${mode ?? "STANDARD"} file limit (${maxFiles})`,
    })
  }

  const skippedByReason = {
    fileLimit: skippedPaths.length,
    oversized: walkState.oversizedFiles,
    walkBounded: walkState.bounded ? 1 : 0,
    unreadable: 0,
    testFixture: 0,
  }
  let bytesScanned = 0

  const findings: EngineVulnerability[] = []
  const seenFindings = new Set<string>()

  for (const filePath of files) {
    throwIfAborted(signal)
    if (findings.length >= MAX_TOTAL_FINDINGS) {
      recordCoverageIssue(coverageIssues, {
        scanner: "sast",
        status: "bounded",
        reason: `SAST finding cap of ${MAX_TOTAL_FINDINGS} reached; remaining files not fully reported`,
      })
      break
    }
    let content: string
    try {
      content = await readFile(filePath, "utf-8")
    } catch {
      skippedByReason.unreadable++
      continue
    }

    const relPath = relative(workspaceDir, filePath)
    if (isTestFixturePath(relPath)) {
      skippedByReason.testFixture++
      continue
    }
    bytesScanned += Buffer.byteLength(content, "utf-8")

    const lines = content.split("\n")
    let findingsInFile = 0

    for (const [index, line] of lines.entries()) {
      if (findingsInFile >= MAX_FINDINGS_PER_FILE) break
      if (isCommentOrBlank(line)) continue

      for (const rule of SAST_RULES) {
        throwIfAborted(signal)
        if (rule.fileVeto?.(content)) continue

        const match = rule.pattern.exec(line)
        if (!match) continue

        const matchedText = match[0]
        if (rule.falsePositiveHints?.some((hint) => line.toLowerCase().includes(hint))) {
          continue
        }
        // Security context is evaluated over a ±1-line window: `const token =`
        // and `func sessionToken() {` live on the line adjacent to the sink.
        const contextWindow = `${lines[index - 1] ?? ""} ${line} ${lines[index + 1] ?? ""}`
        if (rule.requiresSecurityContext && !SECURITY_CONTEXT.test(contextWindow)) {
          continue
        }
        // A weak hash used for etag/checksum purposes is not a security finding.
        if (
          rule.id.startsWith("weak-hash") &&
          NON_SECURITY_HASH_CONTEXT.test(line) &&
          !SECURITY_CONTEXT.test(contextWindow)
        ) {
          continue
        }

        const lineNum = index + 1
        const findingId = `${rule.id}-${relPath}-${lineNum}`
        if (seenFindings.has(findingId)) continue
        seenFindings.add(findingId)

        const controlApplies = Boolean(rule.controlContext?.test(contextWindow))
        const severity =
          rule.strongContext && (controlApplies || rule.strongContext.test(contextWindow))
            ? "high"
            : rule.severity
        findingsInFile++

        findings.push({
          id: findingId,
          title: `${rule.name} in ${relPath}:${lineNum}`,
          severity,
          timestamp: new Date().toISOString(),
          target: relPath,
          cwe: rule.cwe,
          description: rule.description,
          technical_analysis: `${rule.name} detected in ${relPath} at line ${lineNum}. Matched: ${matchedText.slice(0, 120)}.`,
          impact: rule.impact,
          remediation_steps: rule.remediation,
          poc_description: `Review line ${lineNum} of ${relPath}: ${matchedText.slice(0, 120)}.`,
          ...(rule.controlIds && (!rule.controlContext || controlApplies)
            ? { control_ids: rule.controlIds }
            : {}),
          code_locations: [
            {
              file: relPath,
              start_line: lineNum,
              label: rule.name,
              snippet: line.trim().slice(0, 200),
            },
          ],
        })
      }
    }
  }

  if (discovery) {
    discovery.sast = {
      filesScanned: files.length - skippedByReason.unreadable - skippedByReason.testFixture,
      bytesScanned,
      skippedByReason,
      representativeSkippedPaths: skippedPaths
        .slice(0, MAX_REPRESENTATIVE_SKIPPED_PATHS)
        .map((p) => relative(workspaceDir, p)),
    }
  }

  logger.info("SAST scan complete", {
    repoPath,
    findingCount: findings.length,
    filesScanned: files.length,
  })
  return findings
}
