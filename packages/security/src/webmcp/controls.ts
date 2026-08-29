import type { WebMcpControlDefinition, WebMcpControlId } from "./types"

export const WEBMCP_CONTROLS: WebMcpControlDefinition[] = [
  {
    id: "WEBMCP-01",
    title: "WebMCP annotation/behavior mismatch",
    description:
      "A tool claims to be read-only or safe but its implementation performs mutation, network calls, or handles untrusted content inconsistently with its annotations.",
    strategy: "deterministic",
    severity: "HIGH",
    negativeEvidence:
      "Every tool's readOnlyHint, untrustedContentHint, and behavior classification are consistent with its execute body and schema.",
    falsePositiveNotes:
      "Protective wording and educational examples that mention dangerous patterns without exposing a tool must not be flagged.",
    remediationTemplate:
      "Align the tool's annotations with its behavior. Add untrustedContentHint for externally sourced output and remove readOnlyHint when the tool mutates state.",
  },
  {
    id: "WEBMCP-02",
    title: "Externally influenced output lacks untrusted content hint",
    description:
      "A tool fetches or returns content from an external origin, user, or unvalidated source but does not set untrustedContentHint.",
    strategy: "deterministic",
    severity: "MEDIUM",
    negativeEvidence:
      "Every tool that returns external, user-generated, or otherwise unvalidated content sets untrustedContentHint.",
    falsePositiveNotes:
      "Static values, hard-coded templates, and fully server-validated responses are not external influence.",
    remediationTemplate:
      "Set untrustedContentHint for tools whose output is sourced from or influenced by external content.",
  },
  {
    id: "WEBMCP-03",
    title: "Unsafe or dynamic cross-origin tool exposure",
    description:
      "A tool is exposed to an untrusted origin, a wildcard, or a value that cannot be resolved at analysis time.",
    strategy: "deterministic",
    severity: "HIGH",
    negativeEvidence:
      "Every exposedTo value is a precise same-origin or explicitly trusted origin list and is not dynamic.",
    falsePositiveNotes:
      "A missing exposedTo defaults to same-origin and is not by itself a vulnerability.",
    remediationTemplate:
      "Scope exposedTo to the minimum required origins. Replace dynamic or wildcard exposure with an explicit allowlist.",
  },
  {
    id: "WEBMCP-04",
    title: "Explicitly unsafe tool permissions or disabled origin isolation",
    description:
      "The site or config exposes tools broadly through Permissions-Policy: tools=*, Origin-Agent-Cluster: ?0, document.domain manipulation, or delegated cross-origin iframes.",
    strategy: "deterministic",
    severity: "HIGH",
    negativeEvidence:
      "No Permissions-Policy wildcard, no OAC ?0, no document.domain assignment, and no delegated tool iframe is present in assessed source.",
    falsePositiveNotes:
      "Missing explicit hardening headers is a hardening opportunity, not a finding, because the platform default is tools=(self).",
    remediationTemplate:
      "Add Origin-Agent-Cluster: ?1, keep Permissions-Policy tools=(self), remove document.domain assignments, and avoid cross-origin tool delegation.",
  },
  {
    id: "WEBMCP-05",
    title: "Durable/resource-consuming mutation lacks visible confirmation boundary",
    description:
      "A tool performs a durable, resource-consuming, or otherwise destructive mutation without a visible human confirmation step.",
    strategy: "deterministic",
    severity: "CRITICAL",
    negativeEvidence:
      "Every mutation tool in supported files shows an explicit confirmation prompt or is prepared for the user to review before submission.",
    falsePositiveNotes:
      "UI-only state changes, preview-only tools, and read operations are not mutations.",
    remediationTemplate:
      "Add a visible confirmation step before any durable mutation. For declarative forms, omit toolautosubmit and require the user to click Submit.",
  },
  {
    id: "WEBMCP-06",
    title: "Sensitive or unbounded input/output contract",
    description:
      "A tool accepts or returns unbounded, sensitive, or poorly described data without limits or closed schema constraints.",
    strategy: "deterministic",
    severity: "MEDIUM",
    negativeEvidence:
      "Every supported tool schema has bounded string/array lengths, closed object schemas with additionalProperties: false where safe, and descriptions for sensitive fields.",
    falsePositiveNotes:
      "Open-ended string parameters in genuinely optional fields may remain acceptable when other controls are present.",
    remediationTemplate:
      "Add maxLength, maxItems, additionalProperties: false, and clear descriptions. Bound output arrays and mark sensitive parameters.",
  },
  {
    id: "WEBMCP-07",
    title: "Network operation does not forward cancellation",
    description:
      "A tool starts a network request but does not pass the AbortSignal through to fetch, leaving in-flight requests after the caller cancels.",
    strategy: "deterministic",
    severity: "MEDIUM",
    negativeEvidence:
      "Every supported network call forwards the tool's AbortSignal to the underlying fetch or request.",
    falsePositiveNotes: "Synchronous or purely local operations have no signal to forward.",
    remediationTemplate:
      "Forward { signal } into every fetch call inside the tool's execute body and handle the resulting AbortError.",
  },
  {
    id: "WEBMCP-08",
    title: "Component registration lacks lifecycle cleanup",
    description:
      "A tool is registered inside a component or effect without a corresponding cleanup that unregisters it when the context is destroyed.",
    strategy: "deterministic",
    severity: "MEDIUM",
    negativeEvidence:
      "Every supported registration returns or uses an AbortController/abort handler that unregisters the tool on cleanup.",
    falsePositiveNotes:
      "Top-level page or module registrations that are intended to live for the page lifetime may be acceptable.",
    remediationTemplate:
      "Store the registration handle and unregister it in the component or effect cleanup path.",
  },
  {
    id: "WEBMCP-09",
    title: "Weak schema or missing runtime validation at a trust boundary",
    description:
      "A tool accepts structured input without a closed schema, type checks, or a validation library at the trust boundary.",
    strategy: "deterministic",
    severity: "HIGH",
    negativeEvidence:
      "Every supported tool has a closed object schema and uses explicit runtime validation before acting on input.",
    falsePositiveNotes:
      "Primitive-only tools with no object input have a naturally constrained surface.",
    remediationTemplate:
      "Define a strict JSON Schema, set additionalProperties: false for object inputs, and add runtime validation before using tool input.",
  },
  {
    id: "WEBMCP-10",
    title: "Duplicate, overlapping, ambiguous, or misleading tool contract",
    description:
      "Two or more tools share a name, have misleading titles or descriptions, or overlap so much that an agent cannot choose safely.",
    strategy: "deterministic",
    severity: "MEDIUM",
    negativeEvidence:
      "Every tool has a unique name, a clear title and description, and a distinct purpose.",
    falsePositiveNotes:
      "Mentioning similar concepts is not a duplicate; look for identical names or indistinguishable descriptions.",
    remediationTemplate:
      "Rename, merge, or clarify duplicate tools so each has a unique name and a distinct, honest description.",
  },
]

export const WEBMCP_CONTROLS_BY_ID: Record<WebMcpControlId, WebMcpControlDefinition> =
  WEBMCP_CONTROLS.reduce(
    (map, control) => {
      map[control.id] = control
      return map
    },
    {} as Record<WebMcpControlId, WebMcpControlDefinition>
  )

export const WEBMCP_CONTROL_IDS: WebMcpControlId[] = WEBMCP_CONTROLS.map((control) => control.id)
