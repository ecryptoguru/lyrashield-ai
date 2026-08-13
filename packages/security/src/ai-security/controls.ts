import type { AIControlId, AISecurityControlDefinition } from "./types"

export const AI_SECURITY_CONTROLS: AISecurityControlDefinition[] = [
  {
    id: "AI-01",
    title: "Missing prompt-injection input validation",
    owaspMapping: "LLM01:2025",
    description:
      "Detect LLM API calls that receive unsanitized user input without a preceding guard, filter, or validation step.",
    strategy: "deterministic",
    severity: "HIGH",
    negativeEvidence:
      "Every user-facing LLM call in supported files has a visible input-validation, sanitization, or guard step, or the input source is not user-controlled.",
    falsePositiveNotes:
      "Internal-only LLM calls with no user input may be flagged; input source must be request body, query param, or user message to treat as high risk.",
    remediationTemplate:
      "Validate and sanitize user input before passing it to the LLM. Add a prompt-injection guard or input filter.",
  },
  {
    id: "AI-02",
    title: "Sensitive data in LLM context",
    owaspMapping: "LLM02:2025",
    description:
      "Detect API keys, secrets, and PII being placed into LLM prompts, context windows, or logged prompt/response data.",
    strategy: "deterministic",
    severity: "CRITICAL",
    negativeEvidence:
      "No secrets, API keys, or PII are passed into LLM prompts or logged in full prompts/responses in supported files.",
    falsePositiveNotes:
      "Environment variable names containing KEY/TOKEN/SECRET near LLM calls are high-confidence signals.",
    remediationTemplate:
      "Remove secrets and PII from LLM context. Redact or tokenize sensitive values before including them in prompts.",
  },
  {
    id: "AI-03",
    title: "AI library supply chain",
    owaspMapping: "LLM03:2025",
    description:
      "Detect resolved AI/ML dependency versions with known advisories and unbounded dependency declarations without a supported lockfile.",
    strategy: "advisory",
    severity: "MEDIUM",
    negativeEvidence:
      "All AI/ML dependencies are resolved to specific versions in a supported lockfile and a fresh advisory snapshot shows no known vulnerabilities.",
    falsePositiveNotes:
      "Do not report a semver range as vulnerable when the lockfile pins a safe version.",
    remediationTemplate:
      "Pin AI/ML dependencies in a supported lockfile and upgrade versions with known advisories.",
  },
  {
    id: "AI-04",
    title: "LLM output used in dangerous sinks",
    owaspMapping: "LLM05:2025",
    description:
      "Detect LLM output flowing into eval, SQL, shell commands, innerHTML, or filesystem operations without validation.",
    strategy: "deterministic",
    severity: "CRITICAL",
    negativeEvidence:
      "LLM output in supported files is not used in eval, Function, exec, SQL, innerHTML, or unvalidated file/URL operations.",
    falsePositiveNotes:
      "Data-flow from an LLM response variable to a dangerous sink is a high-confidence signal.",
    remediationTemplate:
      "Treat LLM output as untrusted. Validate, encode, or parameterize it before use in any dangerous sink.",
  },
  {
    id: "AI-05",
    title: "Unbounded agent permissions",
    owaspMapping: "LLM06:2025",
    description:
      "Detect agent or MCP tools with destructive actions, auto-approve settings, or missing human-in-the-loop checkpoints.",
    strategy: "deterministic",
    severity: "HIGH",
    negativeEvidence:
      "Destructive tools require explicit human approval and no tool or agent has blanket auto-execute enabled.",
    falsePositiveNotes:
      "Distinguish dev/test tooling from production agents; focus on user-facing or automated execution paths.",
    remediationTemplate:
      "Require human approval for destructive actions. Disable blanket auto-approve and scope tool permissions.",
  },
  {
    id: "AI-06",
    title: "System prompt exposed to client",
    owaspMapping: "LLM07:2025",
    description:
      "Detect system prompts stored in client-side code, public environment variables, or API responses sent to the browser.",
    strategy: "deterministic",
    severity: "HIGH",
    negativeEvidence:
      "No system prompts are present in client-side files, public env vars, or API responses in supported files.",
    falsePositiveNotes: "Client-only demo prompts are still a finding in production-facing code.",
    remediationTemplate:
      "Keep system prompts server-side. Do not expose them in client bundles or public environment variables.",
  },
  {
    id: "AI-07",
    title: "Unauthenticated vector DB / RAG access",
    owaspMapping: "LLM08:2025",
    description:
      "Detect vector database queries and RAG retrieval without access control, workspace scoping, or embedding input validation.",
    strategy: "deterministic",
    severity: "HIGH",
    negativeEvidence:
      "Vector DB clients are initialized with scoped credentials and retrieval filters by workspace/tenant/user in supported files.",
    falsePositiveNotes:
      "Demo or intentionally public vector stores may trigger false positives; require explicit opt-out evidence.",
    remediationTemplate:
      "Add tenant/user scoping to vector queries and validate embedding inputs before ingestion.",
  },
  {
    id: "AI-08",
    title: "Missing LLM consumption limits",
    owaspMapping: "LLM10:2025",
    description:
      "Detect LLM API calls without max_tokens, timeouts, rate limits, or cost/token tracking in agent loops.",
    strategy: "deterministic",
    severity: "MEDIUM",
    negativeEvidence:
      "LLM API calls in supported files include max_tokens, timeout configuration, and rate-limiting middleware or loop budgets.",
    falsePositiveNotes: "Low; absence of these parameters is a clear, checkable pattern.",
    remediationTemplate:
      "Add max_tokens, timeout, and rate-limiting to LLM calls. Cap agent loop iterations and spending.",
  },
]

export const AI_SECURITY_CONTROLS_BY_ID: Record<AIControlId, AISecurityControlDefinition> =
  AI_SECURITY_CONTROLS.reduce(
    (map, control) => {
      map[control.id] = control
      return map
    },
    {} as Record<AIControlId, AISecurityControlDefinition>
  )

export const AI_SECURITY_CONTROL_IDS: AIControlId[] = AI_SECURITY_CONTROLS.map(
  (control) => control.id
)
