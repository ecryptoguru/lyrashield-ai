/**
 * Standards evidence registry — standards-registry/1.1.0.
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
export const STANDARDS_REGISTRY_VERSION = "standards-registry/1.1.0" as const

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

// Category IDs/titles: https://top10.owasp.org/2021/
const OWASP_TOP10: Standard = {
  id: "owasp-top10",
  name: "OWASP Top 10",
  version: "2021",
  defaultSurface: true,
  categories: [
    {
      id: "A01",
      title: "Broken Access Control",
      controlIds: [2, 5, 6, 7, 25, 26],
      cweHints: ["CWE-284", "CWE-639", "CWE-23", "CWE-22"],
      evaluators: [ENGINE, URL],
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
      evaluators: [ENGINE],
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
      evaluators: [ENGINE],
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
      evaluators: [ENGINE],
    },
    {
      id: "API4",
      title: "Unrestricted Resource Consumption",
      controlIds: [21],
      cweHints: ["CWE-770"],
      evaluators: [ENGINE],
    },
    {
      id: "API5",
      title: "Broken Function Level Authorization",
      controlIds: [5, 7],
      cweHints: ["CWE-285"],
      evaluators: [ENGINE],
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
      evaluators: [ENGINE],
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
      evaluators: [ENGINE],
    },
  ],
}

// Category IDs/titles: https://genai.owasp.org/llm-top-10/ (2025 edition).
const OWASP_LLM_TOP10: Standard = {
  id: "owasp-llm-top10",
  name: "OWASP Top 10 for LLM Applications",
  version: "2025",
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
      evaluators: [AI_APP, ENGINE],
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

// Membership/rank: https://cwe.mitre.org/top25/archive/2024/2024_top25_list
const CWE_TOP25: Standard = {
  id: "cwe-top25",
  name: "CWE Top 25 Most Dangerous Software Weaknesses",
  version: "2024",
  defaultSurface: true,
  categories: [
    {
      id: "CWE-79",
      title: "Cross-site Scripting",
      cweHints: ["CWE-79"],
      controlIds: [12],
      evaluators: [ENGINE],
    },
    { id: "CWE-787", title: "Out-of-bounds Write", cweHints: ["CWE-787"], evaluators: [] },
    {
      id: "CWE-89",
      title: "SQL Injection",
      cweHints: ["CWE-89"],
      controlIds: [11],
      evaluators: [ENGINE],
    },
    {
      id: "CWE-352",
      title: "CSRF",
      cweHints: ["CWE-352"],
      controlIds: [15],
      evaluators: [ENGINE, URL],
    },
    {
      id: "CWE-22",
      title: "Path Traversal",
      cweHints: ["CWE-22"],
      controlIds: [18],
      evaluators: [ENGINE],
    },
    { id: "CWE-125", title: "Out-of-bounds Read", cweHints: ["CWE-125"], evaluators: [] },
    {
      id: "CWE-78",
      title: "OS Command Injection",
      cweHints: ["CWE-78"],
      controlIds: [19],
      evaluators: [ENGINE],
    },
    { id: "CWE-416", title: "Use After Free", cweHints: ["CWE-416"], evaluators: [] },
    {
      id: "CWE-862",
      title: "Missing Authorization",
      cweHints: ["CWE-862"],
      controlIds: [5, 7],
      evaluators: [ENGINE],
    },
    {
      id: "CWE-434",
      title: "Unrestricted File Upload",
      cweHints: ["CWE-434"],
      controlIds: [17],
      evaluators: [ENGINE],
    },
    {
      id: "CWE-94",
      title: "Code Injection",
      cweHints: ["CWE-94"],
      controlIds: [45],
      evaluators: [ENGINE, AGENT_CONFIG],
    },
    {
      id: "CWE-20",
      title: "Improper Input Validation",
      cweHints: ["CWE-20"],
      controlIds: [13],
      evaluators: [ENGINE],
    },
    {
      id: "CWE-77",
      title: "Command Injection",
      cweHints: ["CWE-77"],
      controlIds: [19],
      evaluators: [ENGINE],
    },
    {
      id: "CWE-287",
      title: "Improper Authentication",
      cweHints: ["CWE-287"],
      controlIds: [4, 8],
      evaluators: [ENGINE, URL],
    },
    {
      id: "CWE-269",
      title: "Improper Privilege Management",
      cweHints: ["CWE-269"],
      controlIds: [44],
      evaluators: [ENGINE, IAC],
    },
    {
      id: "CWE-502",
      title: "Deserialization of Untrusted Data",
      cweHints: ["CWE-502"],
      controlIds: [39],
      evaluators: [ENGINE, ML_SUPPLY("ml_supply_chain")],
    },
    {
      id: "CWE-200",
      title: "Information Exposure",
      cweHints: ["CWE-200"],
      controlIds: [31, 33],
      evaluators: [ENGINE, URL, AI_APP],
    },
    {
      id: "CWE-863",
      title: "Incorrect Authorization",
      cweHints: ["CWE-863"],
      controlIds: [2, 5],
      evaluators: [ENGINE],
    },
    { id: "CWE-918", title: "SSRF", cweHints: ["CWE-918"], controlIds: [16], evaluators: [ENGINE] },
    { id: "CWE-119", title: "Improper Memory Restriction", cweHints: ["CWE-119"], evaluators: [] },
    { id: "CWE-476", title: "NULL Pointer Dereference", cweHints: ["CWE-476"], evaluators: [] },
    {
      id: "CWE-798",
      title: "Hard-coded Credentials",
      cweHints: ["CWE-798"],
      controlIds: [3],
      evaluators: [SECRETS, IAC, AGENT_CONFIG],
    },
    { id: "CWE-190", title: "Integer Overflow", cweHints: ["CWE-190"], evaluators: [] },
    {
      id: "CWE-400",
      title: "Uncontrolled Resource Consumption",
      cweHints: ["CWE-400"],
      controlIds: [21],
      evaluators: [ENGINE],
    },
    {
      id: "CWE-306",
      title: "Missing Authentication for Critical Function",
      cweHints: ["CWE-306"],
      controlIds: [4, 7],
      evaluators: [ENGINE, URL],
    },
  ],
}

/**
 * Selected, real ASVS 5.0.0 L1 requirements, with short paraphrased labels.
 * Source: https://github.com/OWASP/ASVS/tree/v5.0.0/5.0/en
 * ASVS is licensed CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/
 * This subset is not a complete L1 assessment. Family completion only supplies
 * bounded evidence relevant to a requirement, never a verification result.
 */
const ASVS_L1: Standard = {
  id: "asvs-l1",
  name: "OWASP ASVS Level 1 — selected requirements",
  version: "5.0.0",
  badge: "Selected L1 evidence mapping, not a complete ASVS assessment",
  defaultSurface: true,
  categories: [
    {
      id: "V1.2.1",
      title: "Context-appropriate response encoding",
      controlIds: [12, 13],
      cweHints: ["CWE-79"],
      evaluators: [ENGINE],
    },
    {
      id: "V1.2.4",
      title: "Prevent database query injection",
      controlIds: [11],
      cweHints: ["CWE-89"],
      evaluators: [ENGINE],
    },
    {
      id: "V1.2.5",
      title: "Prevent operating-system command injection",
      controlIds: [19],
      cweHints: ["CWE-78"],
      evaluators: [ENGINE],
    },
    {
      id: "V1.3.2",
      title: "Avoid unsafe dynamic code execution",
      controlIds: [45],
      cweHints: ["CWE-94"],
      evaluators: [ENGINE, AGENT_CONFIG],
    },
    {
      id: "V3.3.1",
      title: "Cookie transport flags and secure prefixes",
      controlIds: [28],
      cweHints: ["CWE-614"],
      evaluators: [URL],
    },
    { id: "V3.4.1", title: "Enforce HTTPS through HSTS", controlIds: [27], evaluators: [URL] },
    {
      id: "V3.4.2",
      title: "Restrict cross-origin access to trusted origins",
      controlIds: [14],
      cweHints: ["CWE-942"],
      evaluators: [ENGINE, URL],
    },
    {
      id: "V6.1.1",
      title: "Document defenses against credential attacks",
      evaluators: [],
      attestable: true,
    },
    {
      id: "V8.1.1",
      title: "Document function and data authorization rules",
      evaluators: [],
      attestable: true,
    },
    {
      id: "V8.2.1",
      title: "Enforce explicit function-level permissions",
      controlIds: [5, 7],
      cweHints: ["CWE-862", "CWE-863"],
      evaluators: [ENGINE],
    },
    {
      id: "V8.2.2",
      title: "Enforce permissions for each data item",
      controlIds: [2, 6],
      cweHints: ["CWE-639"],
      evaluators: [ENGINE],
    },
    {
      id: "V11.3.1",
      title: "Reject insecure cipher modes and padding",
      cweHints: ["CWE-327"],
      evaluators: [SAST, ENGINE],
    },
    {
      id: "V11.3.2",
      title: "Use approved encryption algorithms",
      cweHints: ["CWE-327"],
      evaluators: [SAST, ENGINE],
    },
    {
      id: "V11.4.1",
      title: "Use approved cryptographic hash functions",
      cweHints: ["CWE-328"],
      evaluators: [SAST, ENGINE],
    },
    {
      id: "V12.2.1",
      title: "Use TLS for external HTTP connections",
      controlIds: [29],
      cweHints: ["CWE-319"],
      evaluators: [URL],
    },
    {
      id: "V13.4.1",
      title: "Prevent access to source-control metadata",
      controlIds: [30],
      evaluators: [URL],
    },
  ],
}

// Additional evidence-support mappings (not currently rendered by default).

const OWASP_CICD_TOP10: Standard = {
  id: "owasp-cicd-top10",
  name: "OWASP CI/CD Security Top 10",
  version: "1.0 (2022)",
  badge: "GitHub-workflow partial — other CI systems not yet evaluated",
  defaultSurface: false,
  categories: [
    {
      id: "CICD-SEC-1",
      title: "Insufficient Flow Control",
      evaluators: [AGENT_CONFIG],
      attestable: true,
    },
    {
      id: "CICD-SEC-2",
      title: "Inadequate Identity and Access Management",
      controlIds: [47],
      evaluators: [AGENT_CONFIG],
      attestable: true,
    },
    {
      id: "CICD-SEC-3",
      title: "Dependency Chain Abuse",
      controlIds: [38, 39],
      evaluators: [SCA, IAC],
    },
    {
      id: "CICD-SEC-4",
      title: "Poisoned Pipeline Execution",
      controlIds: [45, 47],
      evaluators: [AGENT_CONFIG, ENGINE],
    },
    {
      id: "CICD-SEC-5",
      title: "Insufficient Pipeline-Based Access Controls",
      controlIds: [47],
      evaluators: [AGENT_CONFIG],
      attestable: true,
    },
    {
      id: "CICD-SEC-6",
      title: "Insufficient Credential Hygiene",
      controlIds: [3],
      evaluators: [SECRETS, IAC, AGENT_CONFIG],
    },
    {
      id: "CICD-SEC-7",
      title: "Insecure System Configuration",
      controlIds: [44],
      evaluators: [AGENT_CONFIG, IAC],
    },
    {
      id: "CICD-SEC-8",
      title: "Ungoverned Usage of 3rd-Party Services",
      evaluators: [AGENT_CONFIG],
      attestable: true,
    },
    {
      id: "CICD-SEC-9",
      title: "Improper Artifact Integrity Validation",
      evaluators: [IAC],
      attestable: true,
    },
    {
      id: "CICD-SEC-10",
      title: "Insufficient Logging and Visibility",
      evaluators: [],
      attestable: true,
    },
  ],
}

const PCI_DSS_SUBSET: Standard = {
  id: "pci-dss-subset",
  name: "PCI DSS — application-security subset",
  version: "4.0.1",
  badge: "Subset: application-facing requirements only, not a PCI assessment",
  defaultSurface: false,
  categories: [
    {
      id: "6.2",
      title: "Bespoke software developed securely",
      controlIds: [11, 12, 13],
      evaluators: [ENGINE, SAST],
      attestable: true,
    },
    {
      id: "6.3",
      title: "Vulnerabilities identified and addressed",
      controlIds: [37],
      evaluators: [SCA, ENGINE],
      attestable: true,
    },
    {
      id: "6.4",
      title: "Public-facing web apps protected",
      controlIds: [11, 12, 16],
      evaluators: [ENGINE, URL],
      attestable: true,
    },
    {
      id: "7.2",
      title: "Access control model established",
      controlIds: [2, 5, 6],
      evaluators: [ENGINE],
      attestable: true,
    },
    {
      id: "8.3",
      title: "Strong authentication for users/admins",
      controlIds: [4, 8, 10],
      evaluators: [ENGINE, URL],
      attestable: true,
    },
    {
      id: "10.1",
      title: "Audit logs capture events",
      controlIds: [33],
      evaluators: [],
      attestable: true,
    },
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
    {
      id: "PW.4",
      title: "Reuse secure components",
      controlIds: [38],
      evaluators: [SCA, IAC],
      attestable: true,
    },
    {
      id: "PW.5",
      title: "Create source code securely",
      evaluators: [SAST, AGENT_CONFIG],
      attestable: true,
    },
    {
      id: "PW.6",
      title: "Toolchain/compiler security",
      evaluators: [AGENT_CONFIG, IAC],
      attestable: true,
    },
    {
      id: "PW.7",
      title: "Review/analyze code for vulnerabilities",
      evaluators: [SAST, ENGINE, SECRETS, IAC],
    },
    { id: "PW.8", title: "Test executable code", evaluators: [ENGINE, URL] },
    { id: "PW.9", title: "Configure secure defaults", evaluators: [IAC, URL] },
    {
      id: "RV.1",
      title: "Identify and confirm vulnerabilities",
      evaluators: [ENGINE, SAST, URL, "external_import" as const],
    },
    { id: "RV.2", title: "Assess, prioritize, remediate", evaluators: [], attestable: true },
    { id: "RV.3", title: "Analyze root causes / trends", evaluators: [], attestable: true },
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
    {
      id: "WSTG-ATHN",
      title: "Authentication testing",
      controlIds: [4, 8, 9],
      evaluators: [ENGINE, URL],
    },
    {
      id: "WSTG-ATHZ",
      title: "Authorization testing",
      controlIds: [2, 5, 6, 7],
      evaluators: [ENGINE],
    },
    {
      id: "WSTG-SESS",
      title: "Session management testing",
      controlIds: [8, 28],
      evaluators: [ENGINE, URL],
    },
    {
      id: "WSTG-INPV",
      title: "Input validation testing",
      controlIds: [11, 12, 13, 16, 17, 18, 19],
      evaluators: [ENGINE],
    },
    { id: "WSTG-ERRH", title: "Error handling", controlIds: [31], evaluators: [ENGINE, URL] },
    {
      id: "WSTG-CRYP",
      title: "Weak cryptography",
      controlIds: [10, 29],
      evaluators: [ENGINE, SAST, URL],
    },
    {
      id: "WSTG-BUSL",
      title: "Business logic testing",
      controlIds: [24, 26],
      evaluators: [ENGINE],
    },
    {
      id: "WSTG-CLNT",
      title: "Client-side testing",
      controlIds: [12, 32],
      evaluators: [ENGINE, URL],
    },
    {
      id: "WSTG-APIT",
      title: "API testing",
      controlIds: [5, 6, 13, 21, 25],
      evaluators: [ENGINE, URL],
    },
  ],
}

const SOC2: Standard = {
  id: "soc2-evidence",
  name: "SOC 2 — audit-evidence export",
  version: "2017 TSC rev 2022",
  badge: "Evidence supports controls — controls belong to your organization",
  defaultSurface: false,
  categories: [
    {
      id: "CC6.1",
      title: "Logical access security",
      controlIds: [2, 5, 44],
      evaluators: [ENGINE, IAC],
      attestable: true,
    },
    {
      id: "CC6.6",
      title: "Boundary protection / vulnerability mgmt",
      evaluators: [ENGINE, SAST, SCA, IAC, URL],
      attestable: true,
    },
    {
      id: "CC6.7",
      title: "Data transmission & movement",
      controlIds: [29, 3],
      evaluators: [URL, SECRETS],
      attestable: true,
    },
    {
      id: "CC7.1",
      title: "Vulnerability & configuration monitoring",
      evaluators: [ENGINE, SAST, SCA, IAC, URL],
      attestable: true,
    },
    { id: "CC7.2", title: "Incident detection monitoring", evaluators: [], attestable: true },
    { id: "CC8.1", title: "Change management", evaluators: [], attestable: true },
  ],
}

const NIST_AI_RMF: Standard = {
  id: "nist-ai-rmf",
  name: "NIST AI Risk Management Framework",
  version: "1.0",
  badge: "Governance framework — evidence supports Measure/Manage functions",
  defaultSurface: false,
  categories: [
    {
      id: "GOVERN",
      title: "Governance — policies, accountability, culture",
      evaluators: [],
      attestable: true,
    },
    {
      id: "MAP",
      title: "Map — context and risk identification",
      evaluators: [AI_APP],
      attestable: true,
    },
    {
      id: "MEASURE",
      title: "Measure — risk assessment and testing",
      evaluators: [AI_APP, ENGINE, SAST, SCA],
    },
    {
      id: "MANAGE",
      title: "Manage — risk response and monitoring",
      evaluators: [ENGINE, URL],
      attestable: true,
    },
  ],
}

// ATLAS, CIS, AISVS, ISO 27001, and SLSA mappings are deferred: the earlier
// entries mixed unsupported identifiers and editions. Restore only after
// checking the exact external revision and scanner-observable scope.
export const STANDARDS_REGISTRY: readonly Standard[] = [
  OWASP_TOP10,
  OWASP_API_TOP10,
  OWASP_LLM_TOP10,
  CWE_TOP25,
  ASVS_L1,
  OWASP_CICD_TOP10,
  PCI_DSS_SUBSET,
  SSDF,
  WSTG,
  SOC2,
  NIST_AI_RMF,
]

export function getStandard(id: string): Standard | undefined {
  return STANDARDS_REGISTRY.find((s) => s.id === id)
}

export function defaultStandards(): readonly Standard[] {
  return STANDARDS_REGISTRY.filter((s) => s.defaultSurface)
}
