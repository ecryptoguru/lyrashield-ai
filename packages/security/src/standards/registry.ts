/**
 * Standards evidence registry — standards-registry/1.0.0.
 *
 * Every standard is pinned by version and rendered from the scan's coverage
 * receipts + findings into three honest states per category:
 *   evaluated            — a mapped scanner family produced evidence this scan
 *   requires-attestation — no scanner can observe it; the org attests out-of-band
 *   not-evaluated        — mappable in principle, but nothing ran that covers it
 *
 * A standard is evidence of coverage, never a claim of certification. The
 * renderer (render.ts) decides the state; this file only declares mappings.
 *
 * Adding a standard = a new versioned entry. Bump STANDARDS_REGISTRY_VERSION
 * when any mapping changes — rendered views are evidence artifacts.
 */
export const STANDARDS_REGISTRY_VERSION = "standards-registry/1.0.0" as const

export type ScannerFamilyName =
  | "engine"
  | "sca"
  | "secrets"
  | "agent_config"
  | "ml_supply_chain"
  | "ai_app_security"
  | "sast"
  | "iac"
  | "url"
  | "external_import"

export interface StandardCategory {
  /** The standard's own identifier — A01, LLM01, CWE-89, V5.1.1, CC6.6. */
  id: string
  title: string
  /** vibe-* control ranks whose receipts evidence this category. */
  controlIds?: number[]
  /** CWE ids — a persisted finding carrying one counts as a violation signal. */
  cweHints?: string[]
  /** Scanner families whose completion receipts evidence this category. */
  evaluators?: ScannerFamilyName[]
  /**
   * True when no scanner can produce the evidence — org attestation required.
   * Combined with evaluators only when a scanner can *partially* observe it.
   */
  attestable?: boolean
}

export interface Standard {
  id: string
  name: string
  /** Pinned version string — rendered verbatim in evidence payloads. */
  version: string
  /** Rendered badge for draft/incubator alignment. */
  badge?: string
  /** The five standards rendered without expansion (hero evidence surface). */
  defaultSurface: boolean
  categories: StandardCategory[]
}

// Vibe-control rank shorthand used below. Ranks are the public contract in
// vibe-security-controls.ts — a rank listed here claims that control's
// receipts evidence the category.
const SAST = "sast" as const
const ENGINE = "engine" as const
const IAC = "iac" as const
const SECRETS = "secrets" as const
const SCA = "sca" as const
const URL = "url" as const
const AGENT_CONFIG = "agent_config" as const
const AI_APP = "ai_app_security" as const

const OWASP_TOP10: Standard = {
  id: "owasp-top10",
  name: "OWASP Top 10",
  version: "2025",
  defaultSurface: true,
  categories: [
    {
      id: "A01",
      title: "Broken Access Control",
      controlIds: [2, 5, 6, 7, 25, 26],
      cweHints: ["CWE-284", "CWE-639", "CWE-23", "CWE-22"],
      evaluators: [ENGINE, SAST, URL],
    },
    {
      id: "A02",
      title: "Cryptographic Failures",
      controlIds: [10, 27, 29, 32],
      cweHints: ["CWE-327", "CWE-328", "CWE-311", "CWE-319"],
      evaluators: [ENGINE, SAST, URL],
    },
    {
      id: "A03",
      title: "Injection",
      controlIds: [11, 12, 13, 19],
      cweHints: ["CWE-89", "CWE-79", "CWE-78", "CWE-94", "CWE-917"],
      evaluators: [ENGINE, SAST],
    },
    {
      id: "A04",
      title: "Insecure Design",
      controlIds: [24, 49],
      evaluators: [ENGINE],
      attestable: true,
    },
    {
      id: "A05",
      title: "Security Misconfiguration",
      controlIds: [14, 28, 29, 30, 31, 32],
      cweHints: ["CWE-16", "CWE-250", "CWE-668"],
      evaluators: [ENGINE, URL, IAC, SAST],
    },
    {
      id: "A06",
      title: "Vulnerable and Outdated Components",
      controlIds: [37],
      cweHints: ["CWE-1104", "CWE-1395"],
      evaluators: [SCA],
    },
    {
      id: "A07",
      title: "Identification and Authentication Failures",
      controlIds: [4, 8, 9, 22],
      cweHints: ["CWE-287", "CWE-384", "CWE-798"],
      evaluators: [ENGINE, URL, SAST],
    },
    {
      id: "A08",
      title: "Software and Data Integrity Failures",
      controlIds: [38, 39, 45, 47],
      cweHints: ["CWE-494", "CWE-829", "CWE-502"],
      evaluators: [SCA, IAC, AGENT_CONFIG, ENGINE],
    },
    {
      id: "A09",
      title: "Security Logging and Monitoring Failures",
      controlIds: [33],
      cweHints: ["CWE-778"],
      evaluators: [ENGINE, AI_APP],
      attestable: true,
    },
    {
      id: "A10",
      title: "Server-Side Request Forgery",
      controlIds: [16],
      cweHints: ["CWE-918"],
      evaluators: [ENGINE, SAST],
    },
  ],
}

const OWASP_API_TOP10: Standard = {
  id: "owasp-api-top10",
  name: "OWASP API Security Top 10",
  version: "2023",
  defaultSurface: true,
  categories: [
    {
      id: "API1",
      title: "Broken Object Level Authorization",
      controlIds: [2, 6],
      cweHints: ["CWE-639", "CWE-284"],
      evaluators: [ENGINE, URL],
    },
    {
      id: "API2",
      title: "Broken Authentication",
      controlIds: [4, 8, 9],
      cweHints: ["CWE-287", "CWE-798"],
      evaluators: [ENGINE, URL],
    },
    {
      id: "API3",
      title: "Broken Object Property Level Authorization",
      controlIds: [25, 30, 33],
      cweHints: ["CWE-915", "CWE-213"],
      evaluators: [ENGINE, SAST],
    },
    {
      id: "API4",
      title: "Unrestricted Resource Consumption",
      controlIds: [21],
      cweHints: ["CWE-770"],
      evaluators: [ENGINE, URL],
    },
    {
      id: "API5",
      title: "Broken Function Level Authorization",
      controlIds: [5, 7],
      cweHints: ["CWE-285"],
      evaluators: [ENGINE, SAST],
    },
    {
      id: "API6",
      title: "Unrestricted Access to Sensitive Business Flows",
      controlIds: [22, 23, 24],
      evaluators: [ENGINE],
    },
    {
      id: "API7",
      title: "Server Side Request Forgery",
      controlIds: [16],
      cweHints: ["CWE-918"],
      evaluators: [ENGINE, SAST],
    },
    {
      id: "API8",
      title: "Security Misconfiguration",
      controlIds: [14, 27, 28, 29, 31],
      cweHints: ["CWE-942", "CWE-319"],
      evaluators: [URL, ENGINE, IAC],
    },
    {
      id: "API9",
      title: "Improper Inventory Management",
      controlIds: [7, 30],
      evaluators: [ENGINE],
      attestable: true,
    },
    {
      id: "API10",
      title: "Unsafe Consumption of APIs",
      controlIds: [13, 16],
      cweHints: ["CWE-20", "CWE-89"],
      evaluators: [ENGINE, SAST],
    },
  ],
}

const OWASP_LLM_TOP10: Standard = {
  id: "owasp-llm-top10",
  name: "OWASP LLM/Agentic Top 10",
  version: "2026",
  defaultSurface: true,
  categories: [
    {
      id: "LLM01",
      title: "Prompt Injection",
      cweHints: ["CWE-77", "CWE-74"],
      evaluators: [AI_APP, ENGINE],
    },
    {
      id: "LLM02",
      title: "Sensitive Information Disclosure",
      controlIds: [3, 33, 40],
      evaluators: [AI_APP, SECRETS, ENGINE],
    },
    {
      id: "LLM03",
      title: "Supply Chain",
      controlIds: [37, 38, 39],
      evaluators: [SCA, ML_SUPPLY("ml_supply_chain"), IAC],
    },
    {
      id: "LLM04",
      title: "Data and Model Poisoning",
      evaluators: [ML_SUPPLY("ml_supply_chain")],
      attestable: true,
    },
    {
      id: "LLM05",
      title: "Improper Output Handling",
      cweHints: ["CWE-20", "CWE-79", "CWE-89"],
      evaluators: [AI_APP, ENGINE, SAST],
    },
    {
      id: "LLM06",
      title: "Excessive Agency",
      controlIds: [42, 44],
      evaluators: [AI_APP, AGENT_CONFIG, IAC],
    },
    {
      id: "LLM07",
      title: "System Prompt Leakage",
      evaluators: [AI_APP, ENGINE],
    },
    {
      id: "LLM08",
      title: "Vector and Embedding Weaknesses",
      evaluators: [AI_APP, ENGINE],
    },
    {
      id: "LLM09",
      title: "Misinformation",
      evaluators: [ENGINE],
      attestable: true,
    },
    {
      id: "LLM10",
      title: "Unbounded Consumption",
      controlIds: [21],
      evaluators: [AI_APP, ENGINE],
    },
  ],
}

// ml_supply_chain is a valid family name; the helper keeps call sites terse.
function ML_SUPPLY(name: "ml_supply_chain"): "ml_supply_chain" {
  return name
}

const CWE_TOP25: Standard = {
  id: "cwe-top25",
  name: "CWE Top 25 Most Dangerous Software Weaknesses",
  version: "2024",
  defaultSurface: true,
  categories: [
    { id: "CWE-787", title: "Out-of-bounds Write", cweHints: ["CWE-787"], evaluators: [SAST] },
    { id: "CWE-79", title: "Cross-site Scripting", cweHints: ["CWE-79"], controlIds: [12], evaluators: [ENGINE, SAST] },
    { id: "CWE-89", title: "SQL Injection", cweHints: ["CWE-89"], controlIds: [11], evaluators: [ENGINE, SAST] },
    { id: "CWE-416", title: "Use After Free", cweHints: ["CWE-416"], evaluators: [] },
    { id: "CWE-78", title: "OS Command Injection", cweHints: ["CWE-78"], controlIds: [19], evaluators: [ENGINE, SAST] },
    { id: "CWE-20", title: "Improper Input Validation", cweHints: ["CWE-20"], controlIds: [13], evaluators: [ENGINE, SAST] },
    { id: "CWE-125", title: "Out-of-bounds Read", cweHints: ["CWE-125"], evaluators: [] },
    { id: "CWE-22", title: "Path Traversal", cweHints: ["CWE-22"], controlIds: [18], evaluators: [ENGINE, SAST] },
    { id: "CWE-352", title: "CSRF", cweHints: ["CWE-352"], controlIds: [15], evaluators: [ENGINE, URL] },
    { id: "CWE-434", title: "Unrestricted File Upload", cweHints: ["CWE-434"], controlIds: [17], evaluators: [ENGINE, SAST] },
    { id: "CWE-862", title: "Missing Authorization", cweHints: ["CWE-862"], controlIds: [5, 7], evaluators: [ENGINE, SAST] },
    { id: "CWE-476", title: "NULL Pointer Dereference", cweHints: ["CWE-476"], evaluators: [SAST] },
    { id: "CWE-287", title: "Improper Authentication", cweHints: ["CWE-287"], controlIds: [4, 8], evaluators: [ENGINE, URL] },
    { id: "CWE-190", title: "Integer Overflow", cweHints: ["CWE-190"], evaluators: [SAST] },
    { id: "CWE-502", title: "Deserialization of Untrusted Data", cweHints: ["CWE-502"], controlIds: [39], evaluators: [ENGINE, SAST, ML_SUPPLY("ml_supply_chain")] },
    { id: "CWE-77", title: "Command Injection", cweHints: ["CWE-77"], controlIds: [19], evaluators: [ENGINE, SAST] },
    { id: "CWE-119", title: "Improper Memory Restriction", cweHints: ["CWE-119"], evaluators: [] },
    { id: "CWE-798", title: "Hard-coded Credentials", cweHints: ["CWE-798"], controlIds: [3], evaluators: [SECRETS, IAC, AGENT_CONFIG] },
    { id: "CWE-918", title: "SSRF", cweHints: ["CWE-918"], controlIds: [16], evaluators: [ENGINE, SAST] },
    { id: "CWE-306", title: "Missing Authentication for Critical Function", cweHints: ["CWE-306"], controlIds: [4, 7], evaluators: [ENGINE, URL] },
    { id: "CWE-269", title: "Improper Privilege Management", cweHints: ["CWE-269"], controlIds: [44], evaluators: [ENGINE, IAC] },
    { id: "CWE-94", title: "Code Injection", cweHints: ["CWE-94"], controlIds: [45], evaluators: [ENGINE, SAST, AGENT_CONFIG] },
    { id: "CWE-863", title: "Incorrect Authorization", cweHints: ["CWE-863"], controlIds: [2, 5], evaluators: [ENGINE, SAST] },
    { id: "CWE-276", title: "Incorrect Default Permissions", cweHints: ["CWE-276"], controlIds: [30], evaluators: [IAC, URL] },
    { id: "CWE-200", title: "Information Exposure", cweHints: ["CWE-200"], controlIds: [31, 33], evaluators: [ENGINE, URL, AI_APP] },
  ],
}

/**
 * ASVS v5.0.0 Level 1 — the verification floor. Each entry is an L1
 * requirement (or requirement group where ASVS numbers the leaf items).
 * evaluators + controlIds map to what LyraShield can observe; requirements
 * no scanner can reach carry attestable with no evaluators →
 * requires-attestation. L2/L3 stay deferred — the registry shape supports
 * them, the mapping labor doesn't yet.
 */
const ASVS_L1: Standard = {
  id: "asvs-l1",
  name: "OWASP ASVS Level 1",
  version: "5.0.0",
  defaultSurface: true,
  categories: [
    // V1 — encoding & sanitization
    { id: "V1.5", title: "Encoding and sanitization basics", controlIds: [11, 12, 13, 19], evaluators: [ENGINE, SAST] },
    // V2 — validation & business logic
    { id: "V2.1", title: "Input validation and documentation", controlIds: [13], evaluators: [ENGINE, SAST] },
    { id: "V2.3", title: "Business logic integrity", controlIds: [24, 26, 49], evaluators: [ENGINE], attestable: true },
    // V3 — web frontend security
    { id: "V3.1", title: "SameSite cookies and CSRF", controlIds: [15, 28], cweHints: ["CWE-352"], evaluators: [ENGINE, URL] },
    { id: "V3.4", title: "Browser security headers", controlIds: [27], evaluators: [URL] },
    { id: "V3.5", title: "DOM XSS and client-side controls", controlIds: [12], cweHints: ["CWE-79"], evaluators: [ENGINE, SAST] },
    // V4 — identity & authn
    { id: "V4.1", title: "Authentication mechanism security", controlIds: [4, 8, 9], cweHints: ["CWE-287"], evaluators: [ENGINE, URL] },
    { id: "V4.2", title: "Credential management", controlIds: [10], cweHints: ["CWE-916", "CWE-327"], evaluators: [ENGINE, SAST] },
    { id: "V4.4", title: "Session management", controlIds: [8, 28], cweHints: ["CWE-384"], evaluators: [ENGINE, URL] },
    // V5 — file handling
    { id: "V5.1", title: "File upload and content handling", controlIds: [17], cweHints: ["CWE-434"], evaluators: [ENGINE, SAST] },
    { id: "V5.2", title: "File integrity and filename handling", controlIds: [17, 18], evaluators: [ENGINE, SAST] },
    // V6 — authorization
    { id: "V6.1", title: "Authorization design and enforcement", controlIds: [2, 5, 6, 7], cweHints: ["CWE-862", "CWE-863"], evaluators: [ENGINE, SAST] },
    { id: "V6.2", title: "Object-level authorization (IDOR)", controlIds: [2, 6], cweHints: ["CWE-639"], evaluators: [ENGINE, URL] },
    // V7 — cryptography
    { id: "V7.2", title: "Algorithm and key strength", controlIds: [10, 29], cweHints: ["CWE-327", "CWE-916"], evaluators: [SAST, ENGINE] },
    { id: "V7.5", title: "Randomness for security purposes", cweHints: ["CWE-338"], controlIds: [10], evaluators: [SAST, ENGINE] },
    // V8 — data protection
    { id: "V8.1", title: "Sensitive data identification and handling", controlIds: [3, 33], cweHints: ["CWE-200"], evaluators: [SECRETS, ENGINE, AI_APP], attestable: true },
    { id: "V8.2", title: "Client-side data protection", controlIds: [3, 32], evaluators: [SECRETS, URL, AI_APP] },
    { id: "V8.4", title: "Data-at-rest protection", controlIds: [10, 29], cweHints: ["CWE-311"], evaluators: [ENGINE, IAC], attestable: true },
    // V9 — communications
    { id: "V9.1", title: "TLS for client connections", controlIds: [29], evaluators: [URL] },
    { id: "V9.3", title: "TLS configuration strength", controlIds: [29], cweHints: ["CWE-326"], evaluators: [URL], attestable: true },
    // V10 — malicious code & integrity
    { id: "V10.1", title: "Code integrity and supply chain", controlIds: [38, 39, 45], cweHints: ["CWE-494"], evaluators: [SCA, IAC, AGENT_CONFIG] },
    { id: "V10.4", title: "Defensive coding and error handling", controlIds: [31, 49], evaluators: [ENGINE, SAST] },
    // V11 — secure configuration
    { id: "V11.1", title: "Configuration hardening", controlIds: [14, 30, 44], cweHints: ["CWE-16"], evaluators: [URL, IAC, ENGINE] },
    { id: "V11.4", title: "Unattended secret storage", controlIds: [3], cweHints: ["CWE-798"], evaluators: [SECRETS, IAC, AGENT_CONFIG] },
    // V12 — secure file & resource access
    { id: "V12.1", title: "File and resource access control", controlIds: [18], cweHints: ["CWE-22"], evaluators: [ENGINE, SAST] },
    // V13 — API & web service
    { id: "V13.1", title: "Generic API security", controlIds: [5, 6, 13], evaluators: [ENGINE, URL] },
    { id: "V13.2", title: "REST/HTTP API security", controlIds: [14, 21, 25], evaluators: [ENGINE, URL] },
    // V14 — configuration (headers/transport duplicates grouped under V11.1)
    { id: "V14.1", title: "Unnecessary features disabled", controlIds: [30, 31], evaluators: [URL, IAC], attestable: true },
    // Logging/availability — attestation-heavy at L1
    { id: "V15.1", title: "Security logging coverage", controlIds: [33], evaluators: [ENGINE], attestable: true },
    { id: "V16.1", title: "Error handling without sensitive disclosure", controlIds: [31], cweHints: ["CWE-209"], evaluators: [ENGINE, URL, SAST] },
  ],
}

// ─── Tier 2 — breadth (behind "All standards") ─────────────────────────────

const OWASP_CICD_TOP10: Standard = {
  id: "owasp-cicd-top10",
  name: "OWASP CI/CD Security Top 10",
  version: "2023",
  badge: "GitHub-workflow partial — other CI systems not yet evaluated",
  defaultSurface: false,
  categories: [
    { id: "CICD-SEC-1", title: "Insufficient Flow Control", evaluators: [AGENT_CONFIG], attestable: true },
    { id: "CICD-SEC-2", title: "Inadequate Identity and Access Management", controlIds: [47], evaluators: [AGENT_CONFIG], attestable: true },
    { id: "CICD-SEC-3", title: "Dependency Chain Abuse", controlIds: [38, 39], evaluators: [SCA, IAC] },
    { id: "CICD-SEC-4", title: "Poisoned Pipeline Execution", controlIds: [45, 47], evaluators: [AGENT_CONFIG, ENGINE] },
    { id: "CICD-SEC-5", title: "Insufficient Pipeline-Based Access Controls", controlIds: [47], evaluators: [AGENT_CONFIG], attestable: true },
    { id: "CICD-SEC-6", title: "Insufficient Credential Hygiene", controlIds: [3], evaluators: [SECRETS, IAC, AGENT_CONFIG] },
    { id: "CICD-SEC-7", title: "Insecure System Configuration", controlIds: [44], evaluators: [AGENT_CONFIG, IAC] },
    { id: "CICD-SEC-8", title: "Ungoverned Usage of 3rd-Party Services", evaluators: [AGENT_CONFIG], attestable: true },
    { id: "CICD-SEC-9", title: "Improper Artifact Integrity Validation", evaluators: [IAC], attestable: true },
    { id: "CICD-SEC-10", title: "Insufficient Logging and Visibility", evaluators: [], attestable: true },
  ],
}

const PCI_DSS_SUBSET: Standard = {
  id: "pci-dss-subset",
  name: "PCI DSS — application-security subset",
  version: "4.0.1",
  badge: "Subset: application-facing requirements only, not a PCI assessment",
  defaultSurface: false,
  categories: [
    { id: "6.2", title: "Bespoke software developed securely", controlIds: [11, 12, 13], evaluators: [ENGINE, SAST], attestable: true },
    { id: "6.3", title: "Vulnerabilities identified and addressed", controlIds: [37], evaluators: [SCA, ENGINE], attestable: true },
    { id: "6.4", title: "Public-facing web apps protected", controlIds: [11, 12, 16], evaluators: [ENGINE, URL], attestable: true },
    { id: "7.2", title: "Access control model established", controlIds: [2, 5, 6], evaluators: [ENGINE], attestable: true },
    { id: "8.3", title: "Strong authentication for users/admins", controlIds: [4, 8, 10], evaluators: [ENGINE, URL], attestable: true },
    { id: "10.1", title: "Audit logs capture events", controlIds: [33], evaluators: [], attestable: true },
  ],
}

const MITRE_ATLAS: Standard = {
  id: "mitre-atlas",
  name: "MITRE ATLAS — AI risk labels",
  version: "2025",
  badge: "Tactic-level labeling, not a test matrix",
  defaultSurface: false,
  categories: [
    { id: "AML.T0051", title: "LLM Prompt Injection", evaluators: [AI_APP, ENGINE] },
    { id: "AML.T0054", title: "LLM Jailbreak", evaluators: [AI_APP, ENGINE] },
    { id: "AML.T0048", title: "External artifacts — poisoned models/deps", controlIds: [39], evaluators: [ML_SUPPLY("ml_supply_chain"), SCA] },
    { id: "AML.T0024", title: "Exfiltration via API/tooling", controlIds: [40, 42], evaluators: [AI_APP, AGENT_CONFIG] },
    { id: "AML.T0046", title: "Discover ML model metadata/surface", evaluators: [ENGINE] },
    { id: "AML.T0000", title: "Reconnaissance of ML system", evaluators: [ENGINE], attestable: true },
  ],
}

const SSDF: Standard = {
  id: "ssdf",
  name: "NIST SSDF SP 800-218 — evidence support",
  version: "1.1",
  badge: "Evidence-support mapping — SSDF is a process standard",
  defaultSurface: false,
  categories: [
    { id: "PO.1", title: "Define security requirements", evaluators: [], attestable: true },
    { id: "PW.4", title: "Reuse secure components", controlIds: [38], evaluators: [SCA, IAC], attestable: true },
    { id: "PW.5", title: "Create source code securely", evaluators: [SAST, AGENT_CONFIG], attestable: true },
    { id: "PW.6", title: "Toolchain/compiler security", evaluators: [AGENT_CONFIG, IAC], attestable: true },
    { id: "PW.7", title: "Review/analyze code for vulnerabilities", evaluators: [SAST, ENGINE, SECRETS, IAC] },
    { id: "PW.8", title: "Test executable code", evaluators: [ENGINE, URL] },
    { id: "PW.9", title: "Configure secure defaults", evaluators: [IAC, URL] },
    { id: "RV.1", title: "Identify and confirm vulnerabilities", evaluators: [ENGINE, SAST, URL, "external_import" as const] },
    { id: "RV.2", title: "Assess, prioritize, remediate", evaluators: [], attestable: true },
    { id: "RV.3", title: "Analyze root causes / trends", evaluators: [], attestable: true },
  ],
}

const SLSA: Standard = {
  id: "slsa",
  name: "SLSA — provenance & build integrity signals",
  version: "1.0",
  badge: "Signals only — SLSA levels are build-system properties",
  defaultSurface: false,
  categories: [
    { id: "SLSA-BUILD-1", title: "Scripted build / provenance exists", evaluators: [AGENT_CONFIG], attestable: true },
    { id: "SLSA-SRC-1", title: "Version-controlled source", evaluators: [], attestable: true },
    { id: "SLSA-DEP-1", title: "Pinned dependencies and base images", controlIds: [38], evaluators: [SCA, IAC] },
    { id: "SLSA-DEP-2", title: "No unpinned remote execution in build", controlIds: [38], evaluators: [IAC] },
  ],
}

const CIS_BENCHMARKS: Standard = {
  id: "cis-benchmarks",
  name: "CIS — container & infra control signals",
  version: "v1.8-docker/k8s-2024",
  badge: "Scanner-observable subset of CIS controls",
  defaultSurface: false,
  categories: [
    { id: "CIS-D-4.1", title: "Container runs as non-root", controlIds: [44], evaluators: [IAC] },
    { id: "CIS-D-4.3", title: "No unnecessary packages/scripts in image", evaluators: [IAC] },
    { id: "CIS-D-4.6", title: "No ADD of remote URLs", evaluators: [IAC] },
    { id: "CIS-D-4.10", title: "No secrets in Dockerfiles", controlIds: [3], evaluators: [IAC, SECRETS] },
    { id: "CIS-K-5.1", title: "RBAC least privilege (no wildcards)", controlIds: [44], evaluators: [IAC] },
    { id: "CIS-K-5.2", title: "Pod security standards (non-root, no hostPath)", controlIds: [44], evaluators: [IAC] },
    { id: "CIS-K-5.7", title: "ServiceAccount tokens not automounted", evaluators: [IAC] },
    { id: "CIS-NET-1", title: "Network segmentation not host-shared", controlIds: [30], evaluators: [IAC] },
  ],
}

const AISVS: Standard = {
  id: "aisvs",
  name: "OWASP AI Security Verification Standard",
  version: "0.1-draft",
  badge: "v0.1 draft — early alignment",
  defaultSurface: false,
  categories: [
    { id: "AISVS-C1", title: "AI application input/output validation", evaluators: [AI_APP, ENGINE] },
    { id: "AISVS-C2", title: "Prompt & context security", evaluators: [AI_APP, ENGINE] },
    { id: "AISVS-C3", title: "Model supply chain integrity", controlIds: [39], evaluators: [ML_SUPPLY("ml_supply_chain"), SCA] },
    { id: "AISVS-C4", title: "Agent autonomy & tool boundaries", controlIds: [42, 44], evaluators: [AI_APP, AGENT_CONFIG, IAC] },
    { id: "AISVS-C5", title: "AI data protection", controlIds: [3, 33], evaluators: [AI_APP, SECRETS], attestable: true },
    { id: "AISVS-C6", title: "AI system monitoring & abuse", evaluators: [], attestable: true },
  ],
}

const WSTG: Standard = {
  id: "owasp-wstg",
  name: "OWASP Web Security Testing Guide",
  version: "4.2",
  badge: "Methodology coverage — exercised is inferred from agent activity, not named test cases",
  defaultSurface: false,
  categories: [
    { id: "WSTG-INFO", title: "Information gathering", evaluators: [ENGINE, URL] },
    { id: "WSTG-CONF", title: "Configuration & deployment testing", evaluators: [URL, IAC] },
    { id: "WSTG-IDNT", title: "Identity management testing", evaluators: [ENGINE] },
    { id: "WSTG-ATHN", title: "Authentication testing", controlIds: [4, 8, 9], evaluators: [ENGINE, URL] },
    { id: "WSTG-ATHZ", title: "Authorization testing", controlIds: [2, 5, 6, 7], evaluators: [ENGINE] },
    { id: "WSTG-SESS", title: "Session management testing", controlIds: [8, 28], evaluators: [ENGINE, URL] },
    { id: "WSTG-INPV", title: "Input validation testing", controlIds: [11, 12, 13, 16, 17, 18, 19], evaluators: [ENGINE, SAST] },
    { id: "WSTG-ERRH", title: "Error handling", controlIds: [31], evaluators: [ENGINE, URL] },
    { id: "WSTG-CRYP", title: "Weak cryptography", controlIds: [10, 29], evaluators: [ENGINE, SAST, URL] },
    { id: "WSTG-BUSL", title: "Business logic testing", controlIds: [24, 26], evaluators: [ENGINE] },
    { id: "WSTG-CLNT", title: "Client-side testing", controlIds: [12, 32], evaluators: [ENGINE, URL] },
    { id: "WSTG-APIT", title: "API testing", controlIds: [5, 6, 13, 21, 25], evaluators: [ENGINE, URL] },
  ],
}

const SOC2: Standard = {
  id: "soc2-evidence",
  name: "SOC 2 — audit-evidence export",
  version: "2017 TSC rev 2022",
  badge: "Evidence supports controls — controls belong to your organization",
  defaultSurface: false,
  categories: [
    { id: "CC6.1", title: "Logical access security", controlIds: [2, 5, 44], evaluators: [ENGINE, IAC], attestable: true },
    { id: "CC6.6", title: "Boundary protection / vulnerability mgmt", evaluators: [ENGINE, SAST, SCA, IAC, URL], attestable: true },
    { id: "CC6.7", title: "Data transmission & movement", controlIds: [29, 3], evaluators: [URL, SECRETS], attestable: true },
    { id: "CC7.1", title: "Vulnerability & configuration monitoring", evaluators: [ENGINE, SAST, SCA, IAC, URL], attestable: true },
    { id: "CC7.2", title: "Incident detection monitoring", evaluators: [], attestable: true },
    { id: "CC8.1", title: "Change management", evaluators: [], attestable: true },
  ],
}

const ISO27001: Standard = {
  id: "iso27001-evidence",
  name: "ISO 27001:2022 — audit-evidence export",
  version: "2022",
  badge: "Evidence supports Annex-A refs — controls belong to your organization",
  defaultSurface: false,
  categories: [
    { id: "A.8.2", title: "Information access restriction", controlIds: [2, 5], evaluators: [ENGINE], attestable: true },
    { id: "A.8.12", title: "Data leakage prevention", controlIds: [3, 33], evaluators: [SECRETS, ENGINE], attestable: true },
    { id: "A.8.16", title: "Monitoring activities", evaluators: [], attestable: true },
    { id: "A.8.25", title: "Secure development lifecycle", evaluators: [SAST, IAC, SCA], attestable: true },
    { id: "A.8.26", title: "Application security requirements", evaluators: [ENGINE, URL, SAST], attestable: true },
    { id: "A.8.28", title: "Secure coding", evaluators: [SAST, SECRETS, IAC] },
    { id: "A.8.29", title: "Security testing in development", evaluators: [ENGINE, URL] },
  ],
}

const NIST_AI_RMF: Standard = {
  id: "nist-ai-rmf",
  name: "NIST AI Risk Management Framework",
  version: "1.0",
  badge: "Governance framework — evidence supports Measure/Manage functions",
  defaultSurface: false,
  categories: [
    { id: "GOVERN", title: "Governance — policies, accountability, culture", evaluators: [], attestable: true },
    { id: "MAP", title: "Map — context and risk identification", evaluators: [AI_APP], attestable: true },
    { id: "MEASURE", title: "Measure — risk assessment and testing", evaluators: [AI_APP, ENGINE, SAST, SCA] },
    { id: "MANAGE", title: "Manage — risk response and monitoring", evaluators: [ENGINE, URL], attestable: true },
  ],
}

export const STANDARDS_REGISTRY: readonly Standard[] = [
  OWASP_TOP10,
  OWASP_API_TOP10,
  OWASP_LLM_TOP10,
  CWE_TOP25,
  ASVS_L1,
  OWASP_CICD_TOP10,
  PCI_DSS_SUBSET,
  MITRE_ATLAS,
  SSDF,
  SLSA,
  CIS_BENCHMARKS,
  AISVS,
  WSTG,
  SOC2,
  ISO27001,
  NIST_AI_RMF,
]

export function getStandard(id: string): Standard | undefined {
  return STANDARDS_REGISTRY.find((s) => s.id === id)
}

export function defaultStandards(): readonly Standard[] {
  return STANDARDS_REGISTRY.filter((s) => s.defaultSurface)
}
