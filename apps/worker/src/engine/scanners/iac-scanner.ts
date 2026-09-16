// security-scan-skip-file: detection rules reference dangerous patterns by design
/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex */
import { lstat, readFile, readdir } from "fs/promises"
import { basename, join, relative } from "path"
import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "../output-parser"
import {
  recordCoverageIssue,
  type ScannerCoverageIssue,
  type ScannerDiscovery,
} from "../scanner-coverage"

interface IacScanConfig {
  repoPath: string
  workspaceDir: string
  signal?: AbortSignal
  coverageIssues?: ScannerCoverageIssue[]
  discovery?: ScannerDiscovery
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("IaC scan cancelled")
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  "vendor",
  ".terraform",
  "__pycache__",
  ".turbo",
  "venv",
  ".venv",
  "target",
])

const MAX_FILE_SIZE = 512 * 1024
const MAX_WALK_ENTRIES = 50_000
const MAX_WALK_DEPTH = 40
const MAX_FINDINGS_PER_FILE = 100
const MAX_TOTAL_FINDINGS = 5_000

type IacFileKind = "dockerfile" | "compose" | "kubernetes" | "terraform"

const K8S_API_VERSION = /^apiVersion:\s*\S+/m
const K8S_KIND =
  /^kind:\s*(Deployment|Pod|DaemonSet|StatefulSet|Job|CronJob|Service|Role|ClusterRole|RoleBinding|ClusterRoleBinding|NetworkPolicy|Ingress|Secret|ConfigMap|ServiceAccount)\b/m
const COMPOSE_SERVICES = /^services:\s*$/m

function classify(path: string, content: string): IacFileKind | null {
  const name = basename(path)
  if (/^Dockerfile(?:\..+)?$/i.test(name) || name.toLowerCase() === "containerfile") {
    return "dockerfile"
  }
  if (/\.tf$/i.test(name)) return "terraform"
  if (/^docker-compose.*\.ya?ml$/i.test(name) || /^compose\.ya?ml$/i.test(name)) {
    return COMPOSE_SERVICES.test(content) ? "compose" : null
  }
  if (/\.ya?ml$/i.test(name) && K8S_API_VERSION.test(content) && K8S_KIND.test(content)) {
    return "kubernetes"
  }
  return null
}

function isIacCandidateName(name: string): boolean {
  return (
    /^Dockerfile(?:\..+)?$/i.test(name) ||
    name.toLowerCase() === "containerfile" ||
    /\.tf$/i.test(name) ||
    /\.ya?ml$/i.test(name)
  )
}

async function walkDir(
  dir: string,
  files: string[],
  state = { entries: 0, bounded: false, oversizedFiles: 0, unreadable: 0 },
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
    state.unreadable++
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
      state.unreadable++
      continue
    }
    if (s.isSymbolicLink()) continue
    if (s.isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) {
        await walkDir(fullPath, files, state, depth + 1, signal)
      }
    } else if (s.isFile()) {
      if (!isIacCandidateName(entry)) continue
      if (s.size <= MAX_FILE_SIZE) {
        files.push(fullPath)
      } else {
        state.oversizedFiles++
      }
    }
  }
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed === "" ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*")
  )
}

/** Track containing variable blocks without treating quoted braces as HCL structure. */
// ponytail: lexical block scope; use an HCL parser if expression or heredoc defaults are added.
function terraformVariableContexts(content: string): Array<string | null> {
  let variableName: string | null = null
  let depth = 0
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      const code = line.replace(/"(?:\\.|[^"\\])*"|#[^\n]*|\/\/[^\n]*/g, (token) =>
        token.startsWith('"') ? token : ""
      )
      const declaration = /^\s*variable\s+"([^"\n]+)"\s*\{/.exec(code)
      if (depth === 0 && declaration) variableName = declaration[1] ?? null
      const current = variableName
      const structure = code.replace(/"(?:\\.|[^"\\])*"/g, "")
      depth += (structure.match(/\{/g)?.length ?? 0) - (structure.match(/\}/g)?.length ?? 0)
      if (depth <= 0) {
        depth = 0
        variableName = null
      }
      return current
    })
}

interface IacRule {
  id: string
  name: string
  kinds: IacFileKind[]
  pattern: RegExp
  severity: "critical" | "high" | "medium" | "low"
  cwe?: string
  description: string
  impact: string
  remediation: string
  controlIds?: number[]
  /** Line-level escape hatch — the match is suppressed when the line also matches. */
  suppressIf?: RegExp
  /** Require a matching resource context somewhere in the file. */
  fileContext?: RegExp
  /** Require the containing Terraform variable name to match. */
  variableContext?: RegExp
}

const IAC_RULES: IacRule[] = [
  // ─── Dockerfile ────────────────────────────────────────────────────────
  {
    id: "iac-dockerfile-latest-base",
    name: "Unpinned or :latest base image",
    kinds: ["dockerfile"],
    pattern: /^FROM\s+(?!scratch\b)[^\s:@#]+(?::latest)?(?:\s+AS\s+\S+)?\s*$/im,
    suppressIf: /:(?!latest\b)[0-9a-zA-Z@]/,
    severity: "medium",
    cwe: "CWE-1104",
    description:
      "A Dockerfile FROM directive uses an untagged or :latest base image. Builds are not reproducible and silently track upstream changes, including compromised ones.",
    impact:
      "Supply-chain drift: a poisoned or breaking base-image update ships in the next build with no review event.",
    remediation:
      "Pin the base image by tag and digest (FROM image:tag@sha256:…). Rebuild on a schedule to pick up patches explicitly.",
    controlIds: [38],
  },
  {
    id: "iac-dockerfile-secret-env",
    name: "Secret material in Dockerfile ENV/ARG",
    kinds: ["dockerfile"],
    pattern:
      /^(?:ENV|ARG)\s+\S*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)\S*\s*=\s*\S+/im,
    severity: "high",
    cwe: "CWE-798",
    description:
      "A Dockerfile sets a credential-shaped ENV or ARG default. Values baked into image layers are readable by anyone who pulls the image.",
    impact:
      "Credentials persist in image history and registries even after the Dockerfile is edited.",
    remediation:
      "Remove the default; inject secrets at runtime via the orchestrator's secret mechanism and rotate the exposed value.",
    controlIds: [3],
  },
  {
    id: "iac-dockerfile-curl-pipe-shell",
    name: "Remote script piped to shell",
    kinds: ["dockerfile"],
    pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b/i,
    severity: "high",
    cwe: "CWE-494",
    description:
      "A build step downloads a remote script and pipes it straight into a shell. The build executes whatever the remote host serves at that moment.",
    impact: "Unsigned remote code execution inside every image build.",
    remediation:
      "Vendor the script at a pinned commit with a checksum, or install through the package manager.",
    controlIds: [38],
  },
  {
    id: "iac-dockerfile-remote-add",
    name: "ADD from a remote URL",
    kinds: ["dockerfile"],
    pattern: /^ADD\s+https?:\/\//im,
    severity: "medium",
    cwe: "CWE-494",
    description:
      "ADD fetches a remote artifact at build time with no integrity check — the build silently picks up whatever the URL serves.",
    impact: "Unpinned remote artifact enters the image; poisoning the URL poisons every build.",
    remediation:
      "COPY a vendored artifact, or download with an explicit checksum verification step.",
    controlIds: [38],
  },
  {
    id: "iac-dockerfile-user-root",
    name: "Container runs as root — no USER directive",
    kinds: ["dockerfile"],
    pattern: /^USER\s+root\b(?:\s+#.*)?$/im,
    severity: "medium",
    cwe: "CWE-250",
    description:
      "The image explicitly runs as root (or never drops privileges). A container escape from the app is one step from host root.",
    impact: "Any RCE in the container runs with maximum in-container privilege.",
    remediation: "Add a non-root USER (create a dedicated user first if the base lacks one).",
    controlIds: [44],
  },
  // ─── docker-compose ────────────────────────────────────────────────────
  {
    id: "iac-compose-privileged",
    name: "Privileged container",
    kinds: ["compose", "kubernetes"],
    pattern: /privileged\s*:\s*true/i,
    severity: "high",
    cwe: "CWE-250",
    description:
      "A service runs with privileged mode, disabling nearly all container isolation (full device access, no seccomp/LSM confinement).",
    impact: "Container breakout is effectively direct host compromise.",
    remediation: "Drop privileged; grant the specific capabilities (cap_add) actually needed.",
    controlIds: [44],
  },
  {
    id: "iac-compose-host-network",
    name: "Host network mode",
    kinds: ["compose"],
    pattern: /network_mode\s*:\s*["']?host/i,
    severity: "medium",
    cwe: "CWE-668",
    description:
      "A service shares the host network namespace — it can reach host-local services and is reachable wherever the host is.",
    impact: "Removes network isolation; localhost-only host services become reachable.",
    remediation: "Use the default bridge network and publish only required ports.",
    controlIds: [30],
  },
  {
    id: "iac-compose-host-pid",
    name: "Host PID namespace",
    kinds: ["compose"],
    pattern: /(?:^|["'\s])pid\s*:\s*["']?host/im,
    severity: "medium",
    cwe: "CWE-668",
    description: "A service shares the host PID namespace and can see and signal host processes.",
    impact: "Enables process inspection and host DoS from inside the container.",
    remediation: "Remove pid: host unless a documented observability agent requires it.",
    controlIds: [44],
  },
  {
    id: "iac-compose-secret-env",
    name: "Hard-coded secret in compose environment",
    kinds: ["compose"],
    pattern: new RegExp(
      `^\\s*[-A-Z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z_]*\\s*[:=]\\s*["']?[^"'\\s$][^"'\\n]*`,
      "im"
    ),
    suppressIf: /\$\{|\$[A-Z_]/,
    severity: "high",
    cwe: "CWE-798",
    description:
      "A compose environment entry hard-codes a credential value. Anyone with repository read access owns the secret.",
    impact:
      "Committed credentials leak through every clone, CI log, and image derived from the file.",
    remediation: "Reference a secret manager or ${VAR} interpolation; rotate the committed value.",
    controlIds: [3],
  },
  // ─── Kubernetes ────────────────────────────────────────────────────────
  {
    id: "iac-k8s-hostpath",
    name: "hostPath volume mount",
    kinds: ["kubernetes"],
    pattern: /hostPath\s*:/i,
    severity: "high",
    cwe: "CWE-668",
    description:
      "A pod mounts a host filesystem path. Containers can read or overwrite host files including other tenants' secrets.",
    impact: "Host filesystem exposure inside the pod boundary.",
    remediation:
      "Use PVCs/configMaps/secrets; gate hostPath behind a Pod Security admission policy.",
    controlIds: [44],
  },
  {
    id: "iac-k8s-wildcard-rbac",
    name: "Wildcard RBAC rule",
    kinds: ["kubernetes"],
    pattern: /["']\*["']/,
    fileContext: /^kind:\s*(Cluster)?Role\b/m,
    severity: "high",
    cwe: "CWE-732",
    description:
      "A Role/ClusterRole grants '*' on resources or verbs — full API access within its scope.",
    impact: "Any workload or credential bound to this role owns the namespace or cluster.",
    remediation: "Scope rules to the exact resources and verbs the workload needs.",
    controlIds: [44],
  },
  {
    id: "iac-k8s-automount-sa-token",
    name: "Service-account token automounted",
    kinds: ["kubernetes"],
    pattern: /automountServiceAccountToken\s*:\s*true/i,
    severity: "medium",
    cwe: "CWE-200",
    description:
      "Pods get a Kubernetes API token mounted by default. Any code execution in the pod can call the cluster API.",
    impact: "Trivial cluster-API access for anything running in the pod.",
    remediation:
      "Set automountServiceAccountToken: false on the ServiceAccount or pod spec unless the workload calls the API.",
    controlIds: [44],
  },
  {
    id: "iac-k8s-run-as-root",
    name: "Pod allowed to run as root",
    kinds: ["kubernetes"],
    pattern: /runAsNonRoot\s*:\s*false|runAsUser\s*:\s*0\b/i,
    severity: "medium",
    cwe: "CWE-250",
    description:
      "The securityContext permits root execution (runAsNonRoot: false or runAsUser: 0).",
    impact: "Container RCE runs at maximum in-container privilege.",
    remediation: "Set runAsNonRoot: true and a non-zero runAsUser.",
    controlIds: [44],
  },
  {
    id: "iac-k8s-missing-security-context",
    name: "Workload without securityContext",
    kinds: ["kubernetes"],
    // The rule fires when the workload file has a containers: list but no
    // securityContext at all — a file-level absence check, not a line match.
    pattern: /^\s*containers\s*:/m,
    fileContext: /securityContext/,
    severity: "low",
    cwe: "CWE-250",
    description:
      "The workload defines containers but no securityContext — no privilege or filesystem restrictions are declared.",
    impact: "No defense-in-depth: containers default to permissive execution.",
    remediation:
      "Add a pod/container securityContext with runAsNonRoot, readOnlyRootFilesystem, and dropped capabilities.",
    controlIds: [44],
  },
  // ─── Terraform ─────────────────────────────────────────────────────────
  {
    id: "iac-tf-open-ingress",
    name: "Security group open to the world",
    kinds: ["terraform"],
    pattern: /cidr_blocks\s*=\s*\[[^\]]*["']0\.0\.0\.0\/0["']/i,
    fileContext: /ingress|security_group|firewall|network_rule/i,
    severity: "high",
    cwe: "CWE-284",
    description:
      "An ingress/firewall rule allows 0.0.0.0/0 — the port range is reachable from the entire internet.",
    impact: "Public exposure of whatever the rule fronts (SSH, databases, admin ports).",
    remediation: "Restrict cidr_blocks to the required source ranges or a bastion/VPN.",
    controlIds: [30],
  },
  {
    id: "iac-tf-public-acl",
    name: "Public object-store ACL",
    kinds: ["terraform"],
    pattern: /acl\s*=\s*["'](?:public-read|public-read-write|authenticated-read)["']/i,
    severity: "high",
    cwe: "CWE-284",
    description: "A storage bucket ACL grants public or authenticated-user read/write.",
    impact: "Bucket contents listable/readable by anyone on the internet.",
    remediation: "Set acl to private; expose objects through signed URLs or a CDN origin identity.",
    controlIds: [30],
  },
  {
    id: "iac-tf-public-bucket-policy",
    name: "Bucket policy grants public access",
    kinds: ["terraform"],
    pattern: /"Principal"\s*:\s*"\*"|Principal\s*=\s*"?\*"?/i,
    fileContext: /bucket|s3|policy/i,
    severity: "high",
    cwe: "CWE-284",
    description: "A bucket/IAM policy statement grants access to Principal '*'.",
    impact: "Anonymous access to the resource the policy covers.",
    remediation: "Replace the wildcard principal with explicit account/role ARNs.",
    controlIds: [30],
  },
  {
    id: "iac-tf-unencrypted-storage",
    name: "Encryption disabled on storage resource",
    kinds: ["terraform"],
    pattern: /encrypted\s*=\s*false|kms_key_id\s*=\s*(?:null|"")/i,
    severity: "medium",
    cwe: "CWE-311",
    description:
      "A storage resource disables encryption or omits a KMS key where the resource supports one.",
    impact: "Data at rest is unprotected against storage-layer access.",
    remediation: "Set encrypted = true and a managed kms_key_id.",
    controlIds: [10],
  },
  {
    id: "iac-tf-iam-wildcard",
    name: "IAM policy wildcard action on all resources",
    kinds: ["terraform"],
    pattern: /actions?\s*=\s*\[[^\]]*["'][a-z]+:\*["']/i,
    severity: "high",
    cwe: "CWE-732",
    description:
      "An IAM policy grants service:* actions — full service control — rather than scoped permissions.",
    impact: "Compromise of the attached principal owns the entire service surface.",
    remediation: "List the exact actions the workload needs; scope resources explicitly.",
    controlIds: [44],
  },
  {
    id: "iac-tf-inline-secret",
    name: "Hard-coded credential in Terraform",
    kinds: ["terraform"],
    pattern:
      /(?:password|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)["']?[^=\n]*=\s*"[^"$\s][^"$]{6,}"/i,
    suppressIf: /var\.|data\.|local\.|each\.|module\.|random_/i,
    severity: "high",
    cwe: "CWE-798",
    description: "A Terraform attribute hard-codes a credential literal.",
    impact: "The secret is committed to version control and written into state files in plaintext.",
    remediation: "Move the value to a variable marked sensitive, or read it from a secret manager.",
    controlIds: [3],
  },
  {
    id: "iac-tf-variable-secret-default",
    name: "Default literal on a secret-named variable",
    kinds: ["terraform"],
    pattern: /default\s*=\s*"[^"$\s][^"$]{6,}"/i,
    variableContext: /password|secret|token|api[_-]?key|private[_-]?key|access[_-]?key/i,
    // A single-line `variable "x" { default = "…" }` is already reported by
    // iac-tf-inline-secret — suppress this rule there to avoid double findings.
    suppressIf: /variable\s+"|var\.|data\.|local\.|each\.|module\.|random_/i,
    severity: "high",
    cwe: "CWE-798",
    description:
      "A variable whose name marks it as a credential carries a hard-coded default literal in a separate attribute — the value is committed to version control and state.",
    impact: "Credential defaults land in git history and tfstate in plaintext.",
    remediation:
      "Remove the default; mark the variable sensitive and source it from a secret manager.",
    controlIds: [3],
  },
]

/** Kubernetes rule that fires on file-level *absence* (no securityContext). */
const K8S_MISSING_SECURITY_CONTEXT = "iac-k8s-missing-security-context"

export async function scanIac(config: IacScanConfig): Promise<EngineVulnerability[]> {
  const { repoPath, workspaceDir, signal, coverageIssues, discovery } = config
  throwIfAborted(signal)
  logger.info("Starting IaC scan", { repoPath })

  const candidates: string[] = []
  const walkState = { entries: 0, bounded: false, oversizedFiles: 0, unreadable: 0 }
  await walkDir(repoPath, candidates, walkState, 0, signal)
  if (walkState.bounded) {
    recordCoverageIssue(coverageIssues, {
      scanner: "iac",
      status: "bounded",
      reason: "IaC file discovery reached its bounded repository walk limit",
    })
  }
  if (walkState.oversizedFiles > 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "iac",
      status: "bounded",
      subject: `${walkState.oversizedFiles} file(s)`,
      reason: `Files exceeding the ${MAX_FILE_SIZE}-byte scanner limit were not inspected`,
    })
  }

  const skippedByReason = {
    oversized: walkState.oversizedFiles,
    walkBounded: walkState.bounded ? 1 : 0,
    unreadable: walkState.unreadable,
    findingLimit: 0,
    notIacContent: 0,
    testFixture: 0,
  }
  let bytesScanned = 0
  let filesScanned = 0

  const findings: EngineVulnerability[] = []
  const seenFindings = new Set<string>()

  for (const [fileIndex, filePath] of candidates.sort().entries()) {
    throwIfAborted(signal)
    if (findings.length >= MAX_TOTAL_FINDINGS) {
      skippedByReason.findingLimit += candidates.length - fileIndex
      recordCoverageIssue(coverageIssues, {
        scanner: "iac",
        status: "bounded",
        reason: `IaC finding cap of ${MAX_TOTAL_FINDINGS} reached; remaining files not fully reported`,
      })
      break
    }
    const relPath = relative(workspaceDir, filePath)
    if (/(?:^|\/)(?:__tests__|fixtures?|testdata|examples?|e2e)(?:\/|$)/i.test(relPath)) {
      skippedByReason.testFixture++
      continue
    }
    let content: string
    try {
      content = await readFile(filePath, "utf-8")
    } catch {
      skippedByReason.unreadable++
      continue
    }
    const kind = classify(filePath, content)
    if (!kind) {
      skippedByReason.notIacContent++
      continue
    }
    bytesScanned += Buffer.byteLength(content, "utf-8")
    filesScanned++

    let findingsInFile = 0
    let findingLimitReached = false

    // File-level absence rules: a Dockerfile with no USER directive runs as
    // root by default; a workload with containers but no securityContext has
    // no declared privilege boundaries.
    if (kind === "dockerfile" && !/^USER\s+\S+/im.test(content)) {
      const rule = IAC_RULES.find((r) => r.id === "iac-dockerfile-user-root")
      if (rule && findingsInFile < MAX_FINDINGS_PER_FILE) {
        findingsInFile++
        findings.push({
          id: `${rule.id}-${relPath}-absent`,
          title: `${rule.name} in ${relPath}`,
          severity: rule.severity,
          timestamp: new Date().toISOString(),
          target: relPath,
          cwe: rule.cwe,
          description: rule.description,
          technical_analysis: `${rule.name} — ${relPath} never sets a USER; the image runs as root by default.`,
          impact: rule.impact,
          remediation_steps: rule.remediation,
          poc_description: `Inspect ${relPath}: no USER directive is present.`,
          ...(rule.controlIds ? { control_ids: rule.controlIds } : {}),
          code_locations: [{ file: relPath, start_line: 1, label: rule.name }],
        })
      }
    }
    if (
      kind === "kubernetes" &&
      /^\s*containers\s*:/m.test(content) &&
      !/securityContext/.test(content)
    ) {
      const rule = IAC_RULES.find((r) => r.id === K8S_MISSING_SECURITY_CONTEXT)
      if (rule && findingsInFile < MAX_FINDINGS_PER_FILE) {
        findingsInFile++
        findings.push({
          id: `${rule.id}-${relPath}`,
          title: `${rule.name} in ${relPath}`,
          severity: rule.severity,
          timestamp: new Date().toISOString(),
          target: relPath,
          cwe: rule.cwe,
          description: rule.description,
          technical_analysis: `${rule.name} — ${relPath} declares containers without any securityContext.`,
          impact: rule.impact,
          remediation_steps: rule.remediation,
          poc_description: `Inspect ${relPath}: containers are declared with no securityContext block.`,
          ...(rule.controlIds ? { control_ids: rule.controlIds } : {}),
          code_locations: [{ file: relPath, start_line: 1, label: rule.name }],
        })
      }
    }

    const lines = content.split("\n")
    const variableContexts = kind === "terraform" ? terraformVariableContexts(content) : []
    for (const [index, line] of lines.entries()) {
      if (findingsInFile >= MAX_FINDINGS_PER_FILE || findings.length >= MAX_TOTAL_FINDINGS) {
        findingLimitReached = true
        break
      }
      if (isCommentOrBlank(line)) continue
      for (const rule of IAC_RULES) {
        if (findingsInFile >= MAX_FINDINGS_PER_FILE || findings.length >= MAX_TOTAL_FINDINGS) {
          findingLimitReached = true
          break
        }
        throwIfAborted(signal)
        if (rule.id === K8S_MISSING_SECURITY_CONTEXT) continue
        if (!rule.kinds.includes(kind)) continue
        if (rule.fileContext && !rule.fileContext.test(content)) continue
        if (rule.variableContext && !rule.variableContext.test(variableContexts[index] ?? ""))
          continue
        // Match and suppress on the code portion only — a trailing comment
        // (or a corpus CASE marker) must neither trigger nor hide a violation.
        const codePart = line.split("#")[0] ?? line
        const match = rule.pattern.exec(codePart)
        if (!match) continue
        if (rule.suppressIf?.test(codePart)) continue

        const lineNum = index + 1
        const findingId = `${rule.id}-${relPath}-${lineNum}`
        if (seenFindings.has(findingId)) continue
        seenFindings.add(findingId)
        findingsInFile++
        findings.push({
          id: findingId,
          title: `${rule.name} in ${relPath}:${lineNum}`,
          severity: rule.severity,
          timestamp: new Date().toISOString(),
          target: relPath,
          cwe: rule.cwe,
          description: rule.description,
          technical_analysis: `${rule.name} detected in ${relPath} at line ${lineNum}. Matched: ${match[0].slice(0, 120)}.`,
          impact: rule.impact,
          remediation_steps: rule.remediation,
          poc_description: `Review line ${lineNum} of ${relPath}: ${match[0].slice(0, 120)}.`,
          ...(rule.controlIds ? { control_ids: rule.controlIds } : {}),
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
    if (findingLimitReached) {
      skippedByReason.findingLimit++
      recordCoverageIssue(coverageIssues, {
        scanner: "iac",
        status: "bounded",
        subject: relPath,
        reason: "IaC finding limit reached; this file was not fully evaluated",
      })
    }
  }

  if (skippedByReason.unreadable > 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "iac",
      status: "partial",
      reason: `IaC could not read or inspect ${skippedByReason.unreadable} repository entries`,
    })
  }

  if (discovery) {
    discovery.iac = {
      filesScanned,
      bytesScanned,
      skippedByReason,
      representativeSkippedPaths: undefined,
    }
  }

  logger.info("IaC scan complete", {
    repoPath,
    findingCount: findings.length,
    filesScanned,
  })
  return findings
}
