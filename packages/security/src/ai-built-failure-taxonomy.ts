/**
 * The LyraShield AI-Built Failure Taxonomy — a named, versioned reference for
 * how AI-generated, AI-driven, AI-native, AI-first, and vibe-coded applications
 * characteristically fail at the point they ship.
 *
 * This is the specialization moat in concrete form: the condition these apps
 * share is that the code shipped without anyone reviewing it for security. Each
 * class names a characteristic failure, the detection surface that covers it,
 * and the controls it maps to.
 *
 * Versioned like the other security catalogs (VIBE_SECURITY_COVERAGE_VERSION,
 * WEBMCP_DETECTOR_VERSION): a change to a class definition, a coverage mapping,
 * or a new class is a version bump, never a silent edit.
 *
 * CONSTRAINT (copy discipline): this taxonomy describes WHAT we test for. It
 * carries NO benchmark numbers and NO detection-rate claims — describing the
 * classes is fine; claiming how well we do against others is not, until
 * measured and founder-approved.
 */

export const AI_BUILT_TAXONOMY_VERSION = "ai-built-failure-taxonomy/1.0.0" as const

/** The detection surface that covers a class (which scanner family owns it). */
export type DetectionSurface =
  "engine" | "sca" | "secrets" | "sast" | "agent_config" | "ai_app_security" | "url" | "webmcp"

export interface AiBuiltFailureClass {
  /** Stable class id, e.g. "AIB-01". */
  id: string
  /** Short, nameable title. */
  title: string
  /** What the characteristic failure is. */
  description: string
  /** Why AI-built apps are prone to it (the mechanism, not the blame). */
  whyAiBuilt: string
  /** The detection surfaces that cover this class. */
  coveredBy: DetectionSurface[]
  /** The vibe-security / WebMCP control ids this class maps to (traceability). */
  controlIds: string[]
  /** Severity if left unreviewed in a shipped app. */
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
}

/**
 * v1.0.0 — the eight characteristic failure classes of AI-built applications,
 * ordered by how directly they put a shipped app at risk.
 */
export const AI_BUILT_FAILURE_TAXONOMY: readonly AiBuiltFailureClass[] = [
  {
    id: "AIB-01",
    title: "Service keys exposed in client bundles",
    description:
      "A privileged service key (database service role, server API key, admin token) is inlined into client-side JavaScript or shipped to the browser, where anyone can read it.",
    whyAiBuilt:
      "A generator optimising for a working demo reaches for the key that works, and nothing reviews the boundary between server-only and client-shipped code.",
    coveredBy: ["secrets", "url"],
    controlIds: ["vibe-03"],
    severity: "CRITICAL",
  },
  {
    id: "AIB-02",
    title: "Missing auth on generated endpoints",
    description:
      "An API route or server action is generated and exposed with no authentication or authorization check, because the happy path worked without one.",
    whyAiBuilt:
      "The model produces the endpoint that answers the request; whether a caller must prove identity is a property it does not add unless asked.",
    coveredBy: ["engine", "sast", "url"],
    controlIds: ["vibe-04", "vibe-05"],
    severity: "CRITICAL",
  },
  {
    id: "AIB-03",
    title: "Permissive row-level security left in place",
    description:
      "Row-level security is enabled but the policies are permissive (or a blanket allow), so any authenticated user reads or writes every row.",
    whyAiBuilt:
      "An ORM scaffold with RLS 'on' looks correct and passes a smoke test while the policy grants far more than intended.",
    coveredBy: ["engine", "sast"],
    controlIds: ["vibe-02"],
    severity: "HIGH",
  },
  {
    id: "AIB-04",
    title: "Over-broad API and tool scopes",
    description:
      "A token, service account, or agent tool is granted far wider scope than its task needs — read-write where read-only would do, all repos where one would do.",
    whyAiBuilt:
      "The fastest way to make an integration work is the broadest grant; least-privilege scoping is a separate pass that does not happen.",
    coveredBy: ["agent_config", "ai_app_security"],
    controlIds: ["vibe-42", "WEBMCP-04"],
    severity: "HIGH",
  },
  {
    id: "AIB-05",
    title: "Secrets inside agent tool definitions",
    description:
      "A credential, connection string, or token is embedded in an agent tool definition, system prompt, or tool schema, where it is disclosed to the model and anyone who can read the tool surface.",
    whyAiBuilt:
      "Wiring a tool to a live service is easiest by pasting the credential where the tool is declared; the tool definition is not treated as a secret boundary.",
    coveredBy: ["agent_config", "secrets", "webmcp"],
    controlIds: ["vibe-40"],
    severity: "HIGH",
  },
  {
    id: "AIB-06",
    title: "Unvalidated model output flows into queries or commands",
    description:
      "Text a model produced is concatenated into a SQL query, shell command, or other interpreter without validation or parameterisation.",
    whyAiBuilt:
      "The model's output looks like the answer, so it is piped straight into the next step; the injection boundary between model output and code is invisible.",
    coveredBy: ["engine", "sast"],
    controlIds: ["vibe-11", "vibe-19"],
    severity: "HIGH",
  },
  {
    id: "AIB-07",
    title: "Placeholder logic that ships as if real",
    description:
      "A generated stub — a tautological check, a hard-coded success, a TODO that returns true — ships in a security-relevant path and silently always passes.",
    whyAiBuilt:
      "The model fills the shape of the function before the substance exists, and a green-looking result is indistinguishable from a real one without review.",
    coveredBy: ["engine", "sast"],
    controlIds: ["vibe-49"],
    severity: "MEDIUM",
  },
  {
    id: "AIB-08",
    title: "Dependency pulled in without vetting",
    description:
      "A package is added for a one-line task, sometimes hallucinated or typosquatted, carrying known vulnerabilities or an unsafe install script.",
    whyAiBuilt:
      "The model names a plausible package for the task; whether that package exists, is maintained, or is the real one is not checked.",
    coveredBy: ["sca"],
    controlIds: ["vibe-37", "vibe-39"],
    severity: "MEDIUM",
  },
] as const

/** Map of class id → class for O(1) lookup. */
export const AI_BUILT_FAILURE_MAP: Readonly<Record<string, AiBuiltFailureClass>> =
  Object.fromEntries(AI_BUILT_FAILURE_TAXONOMY.map((c) => [c.id, c])) as Readonly<
    Record<string, AiBuiltFailureClass>
  >

/** Classes covered by a given detection surface. */
export function classesCoveredBy(surface: DetectionSurface): AiBuiltFailureClass[] {
  return AI_BUILT_FAILURE_TAXONOMY.filter((c) => c.coveredBy.includes(surface))
}

/** Detection surfaces with at least one class mapped (coverage completeness check). */
export function coveredSurfaces(): DetectionSurface[] {
  const set = new Set<DetectionSurface>()
  for (const c of AI_BUILT_FAILURE_TAXONOMY) for (const s of c.coveredBy) set.add(s)
  return [...set]
}
