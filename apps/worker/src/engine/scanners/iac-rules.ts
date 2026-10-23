// security-scan-skip-file: detection rules reference dangerous patterns by design
/* eslint-disable security/detect-unsafe-regex */
export type IacFileKind = "dockerfile" | "compose" | "kubernetes" | "terraform"

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

export const IAC_RULES: IacRule[] = [
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
export const K8S_MISSING_SECURITY_CONTEXT = "iac-k8s-missing-security-context"
