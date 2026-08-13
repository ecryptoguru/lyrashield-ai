/* eslint-disable security/detect-non-literal-fs-filename */
import { lstat, readFile, readdir } from "fs/promises"
import type { Dirent } from "fs"
import { join } from "path"
import type { EngineVulnerability } from "../output-parser"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"

const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 5 * 1024 * 1024
const MAX_FILES = 500
const MAX_WALK_ENTRIES = 20_000
const MAX_WALK_DEPTH = 40
const SOURCE_EXTENSIONS = new Set([".py", ".json", ".yaml", ".yml", ".toml"])
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "build",
  "dist",
  "node_modules",
  "vendor",
  "venv",
  ".venv",
])
const IMMUTABLE_REVISION = /(?:revision|commit_hash)\s*=\s*["'][a-f0-9]{7,64}["']/i

export interface MlSupplyChainScanConfig {
  repoPath: string
  coverageIssues?: ScannerCoverageIssue[]
  signal?: AbortSignal
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("ML supply-chain scan cancelled")
}

function finding(
  id: string,
  title: string,
  severity: "HIGH" | "MEDIUM",
  cwe: string,
  description: string,
  remediation: string,
  file: string,
  line: number,
  snippet: string
): EngineVulnerability {
  return {
    id,
    title,
    severity,
    timestamp: new Date().toISOString(),
    target: file,
    cwe,
    description,
    remediation_steps: remediation,
    control_ids: [39],
    code_locations: [{ file, start_line: line, end_line: line, snippet: snippet.slice(0, 240) }],
  }
}

function findingsForLine(file: string, line: string, lineNumber: number): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  if (/\btorch\.load\s*\(/.test(line) && !/weights_only\s*=\s*True\b/.test(line)) {
    findings.push(
      finding(
        `ml-unsafe-torch-load-${file}-${lineNumber}`,
        "Potential unsafe PyTorch model deserialization",
        "HIGH",
        "CWE-502",
        "torch.load can execute unsafe pickle payloads unless loading is restricted to weights-only data.",
        "Use weights_only=True where supported, or replace untrusted serialized models with a safer format such as safetensors.",
        file,
        lineNumber,
        line
      )
    )
  }
  if (/\b(?:pickle|joblib)\.load\s*\(/.test(line)) {
    findings.push(
      finding(
        `ml-unsafe-deserialization-${file}-${lineNumber}`,
        "Unsafe Python model deserialization",
        "HIGH",
        "CWE-502",
        "pickle.load or joblib.load deserializes executable Python objects from the referenced file.",
        "Do not deserialize untrusted model files; use a non-executable format and verify the model source before loading it.",
        file,
        lineNumber,
        line
      )
    )
  }
  if (
    /(?:^|\W)(?:from_pretrained|snapshot_download)\s*\(/.test(line) &&
    !IMMUTABLE_REVISION.test(line)
  ) {
    findings.push(
      finding(
        `ml-mutable-model-revision-${file}-${lineNumber}`,
        "Mutable model revision reference",
        "MEDIUM",
        "CWE-829",
        "The model download reference does not include an immutable commit SHA or revision.",
        "Pin the model download to its immutable repository revision and record the source in the release inventory.",
        file,
        lineNumber,
        line
      )
    )
  }
  return findings
}

async function findCandidateFiles(
  repoPath: string,
  coverageIssues?: ScannerCoverageIssue[],
  signal?: AbortSignal
): Promise<string[]> {
  const files: string[] = []
  const state = { entries: 0, bounded: false }
  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    throwIfAborted(signal)
    if (depth > MAX_WALK_DEPTH || state.entries >= MAX_WALK_ENTRIES || files.length >= MAX_FILES) {
      state.bounded = true
      return
    }
    let entries: Dirent<string>[]
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" })
    } catch {
      return
    }
    for (const entry of entries) {
      throwIfAborted(signal)
      if (++state.entries > MAX_WALK_ENTRIES || files.length >= MAX_FILES) {
        state.bounded = true
        break
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name))
          await visit(join(directory, entry.name), relativePath, depth + 1)
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(`.${entry.name.split(".").pop() ?? ""}`)) {
        files.push(relativePath)
      }
    }
  }
  await visit(repoPath, "", 0)
  if (state.bounded) {
    recordCoverageIssue(coverageIssues, {
      scanner: "ml_supply_chain",
      status: "bounded",
      reason: "ML supply-chain discovery reached its bounded repository walk limit",
    })
  }
  return files
}

export async function scanMlSupplyChain(
  config: MlSupplyChainScanConfig
): Promise<EngineVulnerability[]> {
  const findings: EngineVulnerability[] = []
  let totalBytes = 0
  for (const file of await findCandidateFiles(
    config.repoPath,
    config.coverageIssues,
    config.signal
  )) {
    throwIfAborted(config.signal)
    try {
      const fullPath = join(config.repoPath, file)
      const stat = await lstat(fullPath)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      if (stat.size > MAX_FILE_BYTES || totalBytes + stat.size > MAX_TOTAL_BYTES) {
        recordCoverageIssue(config.coverageIssues, {
          scanner: "ml_supply_chain",
          status: "bounded",
          subject: file,
          reason: `Model source exceeds the ${MAX_FILE_BYTES}-byte file or ${MAX_TOTAL_BYTES}-byte scan limit`,
        })
        continue
      }
      const content = await readFile(fullPath, "utf8")
      totalBytes += Buffer.byteLength(content)
      for (const [index, line] of content.split("\n").entries()) {
        throwIfAborted(config.signal)
        findings.push(...findingsForLine(file, line, index + 1))
      }
    } catch {
      recordCoverageIssue(config.coverageIssues, {
        scanner: "ml_supply_chain",
        status: "partial",
        subject: file,
        reason: "Model source could not be read",
      })
    }
  }
  return findings
}
