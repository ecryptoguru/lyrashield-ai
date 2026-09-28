import {
  redactUrlForLogs,
  type SurfaceCollectionIssue,
  type SurfaceSignal,
  type SurfaceSubject,
} from "@lyrashield/security"
import {
  URL_SCAN_CONTRACT_VERSION,
  type UrlRequestMethod,
  type UrlScanProfile,
  type UrlExecutionSummary,
} from "@lyrashield/types"
import type { EngineVulnerability } from "../output-parser"

export type OpenApiOperationAttempt = {
  method: "GET" | "HEAD" | "OPTIONS"
  path: string
  url: string
}

export type OpenApiScannerResult = {
  findings: EngineVulnerability[]
  signals: SurfaceSignal[]
  subjects: SurfaceSubject[]
  issues: SurfaceCollectionIssue[]
  attemptedOperations: OpenApiOperationAttempt[]
  execution: UrlExecutionSummary
}

export type OpenApiSpec = {
  openapi?: string
  servers?: Array<{ url: string }>
  security?: Array<Record<string, unknown>>
  paths?: Record<string, OpenApiPathItem>
  components?: unknown
}

export type OpenApiPathItem = Partial<
  Record<"get" | "head" | "options" | "post" | "put" | "patch" | "delete", OpenApiOperation>
> & { parameters?: OpenApiParameter[] }

export type OpenApiOperation = {
  operationId?: string
  summary?: string
  description?: string
  security?: Array<Record<string, unknown>>
  parameters?: OpenApiParameter[]
  responses?: Record<string, OpenApiResponse>
}

type OpenApiParameter = {
  name: string
  in: "query" | "path" | "header" | "cookie"
  required?: boolean
  example?: unknown
  default?: unknown
  enum?: unknown[]
  schema?: OpenApiSchema
}

type OpenApiSchema = {
  type?: string
  required?: string[]
  properties?: Record<string, OpenApiSchema>
  items?: OpenApiSchema
  example?: unknown
  default?: unknown
  enum?: unknown[]
}

type OpenApiResponse = {
  description?: string
  content?: Record<string, { schema?: OpenApiSchema }>
}

export function buildEmptyExecution(
  profile: UrlScanProfile,
  issueCodes: string[] = []
): UrlExecutionSummary {
  return {
    contractVersion: URL_SCAN_CONTRACT_VERSION,
    profile: profile.id,
    methods: [...new Set(profile.allowedMethods)].sort() as UrlRequestMethod[],
    subjectCount: 0,
    documentCount: 0,
    assetCount: 0,
    operationCount: 0,
    methodProbeCount: 0,
    originProbeCount: 0,
    totalBytes: 0,
    truncated: false,
    issueCodes: [...issueCodes].sort(),
  }
}

export const ALL_SAFE_METHODS: UrlRequestMethod[] = ["GET", "HEAD", "OPTIONS"]

export const METHOD_TO_KEY: Record<UrlRequestMethod, "get" | "head" | "options"> = {
  GET: "get",
  HEAD: "head",
  OPTIONS: "options",
}
const SENSITIVE_PARAM_NAMES = new Set([
  "authorization",
  "token",
  "api-key",
  "api_key",
  "apikey",
  "cookie",
  "session",
  "password",
  "secret",
  "client_id",
  "client_secret",
])

function isSensitiveParamName(name: string): boolean {
  return SENSITIVE_PARAM_NAMES.has(name.toLowerCase())
}

export function urlOrigin(url: string): string {
  return new URL(url).origin
}

export function resolveServer(spec: OpenApiSpec, targetUrl: string): string {
  const servers = spec.servers
  if (!servers || servers.length === 0) return targetUrl
  const candidate = servers[0]?.url
  if (!candidate) return targetUrl
  if (/^https?:\/\//.test(candidate)) return candidate
  // Relative server URL resolved against target origin.
  const base = new URL(targetUrl)
  return new URL(candidate, `${base.origin}/`).toString()
}

export function operationHasAuth(
  operation: OpenApiOperation,
  rootSecurity: Array<Record<string, unknown>> | undefined
): boolean {
  const effectiveSecurity: unknown = operation.security ?? rootSecurity
  if (effectiveSecurity === undefined) return false
  if (!Array.isArray(effectiveSecurity)) return true
  if (effectiveSecurity.length === 0) return false
  if (
    effectiveSecurity.some(
      (requirement) => !requirement || typeof requirement !== "object" || Array.isArray(requirement)
    )
  ) {
    return true
  }
  return effectiveSecurity.every((requirement) => Object.keys(requirement).length > 0)
}

function resolveLocalRef(spec: OpenApiSpec, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined
  const parts = ref.slice(1).split("/").filter(Boolean)
  let current: unknown = spec
  for (const part of parts) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

const MAX_REF_DEPTH = 32

export function deepDeref(
  spec: OpenApiSpec,
  value: unknown,
  resolvingRefs = new Set<string>(),
  objectPath = new WeakSet<object>(),
  depth = 0
): unknown {
  if (depth >= MAX_REF_DEPTH) {
    if (Array.isArray(value)) return []
    if (value && typeof value === "object") {
      return "$ref" in value && typeof value.$ref === "string" ? value : {}
    }
    return value
  }
  if (Array.isArray(value)) {
    if (objectPath.has(value)) return []
    objectPath.add(value)
    try {
      return value.map((v) => deepDeref(spec, v, resolvingRefs, objectPath, depth + 1))
    } finally {
      objectPath.delete(value)
    }
  }
  if (value && typeof value === "object") {
    if (objectPath.has(value)) return {}
    if ("$ref" in value && typeof value.$ref === "string") {
      if (resolvingRefs.has(value.$ref)) return value
      const resolved = resolveLocalRef(spec, value.$ref)
      if (resolved === undefined) return value
      const nextRefs = new Set(resolvingRefs)
      nextRefs.add(value.$ref)
      return deepDeref(spec, resolved, nextRefs, objectPath, depth + 1)
    }
    objectPath.add(value)
    const result: Record<string, unknown> = {}
    try {
      for (const [key, v] of Object.entries(value)) {
        result[key] = deepDeref(spec, v, resolvingRefs, objectPath, depth + 1)
      }
    } finally {
      objectPath.delete(value)
    }
    return result
  }
  return value
}

export function mergeParameters(
  pathParameters: unknown,
  operationParameters: unknown
): OpenApiParameter[] {
  const merged = new Map<string, OpenApiParameter>()
  for (const parameter of [
    ...normalizeParameters(pathParameters),
    ...normalizeParameters(operationParameters),
  ]) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter)
  }
  return [...merged.values()]
}

function normalizeParameters(value: unknown): OpenApiParameter[] {
  if (!Array.isArray(value)) return []
  return value.filter((parameter): parameter is OpenApiParameter => {
    if (!parameter || typeof parameter !== "object") return false
    const candidate = parameter as Record<string, unknown>
    return (
      typeof candidate.name === "string" &&
      typeof candidate.in === "string" &&
      ["query", "path", "header", "cookie"].includes(candidate.in)
    )
  })
}

function getExampleValue(param: OpenApiParameter): string | undefined {
  if (param.example !== undefined) return String(param.example)
  if (param.schema?.example !== undefined) return String(param.schema.example)
  if (param.default !== undefined) return String(param.default)
  if (param.schema?.default !== undefined) return String(param.schema.default)
  if (param.enum?.length) return String(param.enum[0])
  if (param.schema?.enum?.length) return String(param.schema.enum[0])
  return undefined
}

export function operationRequiresParams(operation: OpenApiOperation): boolean {
  const parameters = normalizeParameters(operation.parameters)
  if (parameters.length === 0) return false
  for (const param of parameters) {
    if (param.in === "header" || param.in === "cookie") return true
    if (isSensitiveParamName(param.name)) return true
    if (param.in === "query" && param.required && getExampleValue(param) === undefined) return true
  }
  return false
}

export function buildOperationUrl(
  base: string,
  pathTemplate: string,
  parameters: OpenApiParameter[]
): { url: string; issues: SurfaceCollectionIssue[] } {
  const issues: SurfaceCollectionIssue[] = []
  let filledPath = pathTemplate

  for (const param of parameters) {
    if (param.in === "header" || param.in === "cookie") continue
    if (isSensitiveParamName(param.name)) continue

    const value = getExampleValue(param)
    if (param.in === "path") {
      if (value === undefined) {
        issues.push({
          code: "PARAMETER_VALUE_UNAVAILABLE",
          subject: redactUrlForLogs(`${base.replace(/\/$/, "")}${pathTemplate}`),
          reason: `Path parameter "${param.name}" has no example, default, or enum value.`,
        })
        continue
      }
      filledPath = filledPath.replace(`{${param.name}}`, encodeURIComponent(value))
    } else if (param.in === "query") {
      // Query parameters are not sent in the request URL to stay within the
      // SSRF guard's "no query" rule. A documented value is still required to
      // consider the operation fillable.
      if (value === undefined) {
        issues.push({
          code: "PARAMETER_VALUE_UNAVAILABLE",
          subject: redactUrlForLogs(`${base.replace(/\/$/, "")}${pathTemplate}`),
          reason: `Query parameter "${param.name}" has no example, default, or enum value.`,
        })
      }
    }
  }

  if (/\{[^}]+\}/.test(filledPath)) {
    issues.push({
      code: "PARAMETER_VALUE_UNAVAILABLE",
      subject: redactUrlForLogs(`${base.replace(/\/$/, "")}${pathTemplate}`),
      reason: "A path parameter has no usable documented value.",
    })
  }

  const url = new URL(filledPath, `${base.replace(/\/$/, "")}/`)
  return { url: url.toString(), issues }
}

function hasUnsupportedComposition(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false
  if (Array.isArray(schema)) return schema.some((s) => hasUnsupportedComposition(s))
  const s = schema as Record<string, unknown>
  if ("allOf" in s || "oneOf" in s || "anyOf" in s || "not" in s) return true
  if (s.type === "object" && s.properties) {
    for (const child of Object.values(s.properties)) {
      if (hasUnsupportedComposition(child)) return true
    }
  }
  if (s.type === "array" && s.items) {
    if (hasUnsupportedComposition(s.items)) return true
  }
  return false
}

export function validateResponseContent(
  url: string,
  status: number,
  contentType: string | undefined,
  operation: OpenApiOperation
): { issues: SurfaceCollectionIssue[]; schemaUnsupported: boolean } {
  const issues: SurfaceCollectionIssue[] = []
  let schemaUnsupported = false
  const declared = operation.responses?.[`${status}`]
  if (!declared) return { issues, schemaUnsupported }

  if (declared.content) {
    const declaredTypes = Object.keys(declared.content)
    if (contentType && !declaredTypes.includes(contentType)) {
      // Allow declared `application/json` when response is JSON-ish
      if (!(declaredTypes.includes("application/json") && /json/.test(contentType))) {
        issues.push({
          code: "SCHEMA_UNSUPPORTED",
          subject: redactUrlForLogs(url),
          reason: `Response content type "${contentType}" is not declared for status ${status}.`,
        })
      }
    }

    const schema = declared.content["application/json"]?.schema
    if (schema && hasUnsupportedComposition(schema)) {
      schemaUnsupported = true
      issues.push({
        code: "SCHEMA_UNSUPPORTED",
        subject: redactUrlForLogs(url),
        reason: "Declared response schema contains non-scalar compositions not yet supported.",
      })
    }
  }

  return { issues, schemaUnsupported }
}

function controlToCwe(controlId: number | undefined): string {
  switch (controlId) {
    case 3:
      return "CWE-798"
    case 14:
      return "CWE-942"
    case 27:
      return "CWE-693"
    case 28:
      return "CWE-614"
    case 29:
      return "CWE-319"
    case 31:
      return "CWE-209"
    case 32:
      return "CWE-540"
    default:
      return "CWE-693"
  }
}

export function toEngineVulnerability(signal: SurfaceSignal): EngineVulnerability {
  const controlId = signal.controlIds[0]
  return {
    id: signal.id,
    title: signal.title,
    severity: (signal.severity ?? "MEDIUM").toLowerCase(),
    timestamp: new Date().toISOString(),
    cwe: controlToCwe(controlId),
    description: signal.description,
    remediation_steps: signal.remediation,
    control_ids: [...signal.controlIds],
    target: signal.subjectUrl,
    endpoint: signal.subjectUrl,
    evidence: JSON.stringify(signal.evidence),
  }
}

export function operationSignal(
  operation: OpenApiOperationAttempt,
  status: number,
  contentType?: string
): SurfaceSignal {
  return {
    id: `openapi.operation.${operation.method}.${Buffer.from(operation.path).toString("base64url")}`,
    subjectUrl: redactUrlForLogs(operation.url),
    controlIds: [13],
    state: "OBSERVED",
    severity: "INFO",
    title: `OpenAPI ${operation.method} operation observed`,
    description: `The contract declares ${operation.method} ${operation.path} and the server responded with status ${status}.`,
    evidence: {
      path: operation.path,
      method: operation.method,
      status,
      contentType: contentType ?? "",
    },
  }
}

export function authRequiredSignal(operation: OpenApiOperationAttempt): SurfaceSignal {
  return {
    id: `openapi.auth-required.${Buffer.from(operation.path).toString("base64url")}`,
    subjectUrl: redactUrlForLogs(operation.url),
    controlIds: [13],
    state: "DETECTED",
    severity: "MEDIUM",
    title: "OpenAPI operation requires authentication",
    description: `The contract declares ${operation.method} ${operation.path} with security requirements, so it was not probed without credentials.`,
    evidence: { path: operation.path, method: operation.method },
  }
}

export function isReflectedCors(headers: Record<string, string>, sentOrigin: string): boolean {
  const allowOrigin = headers["access-control-allow-origin"]
  if (!allowOrigin || allowOrigin === "*") return false
  if (allowOrigin !== sentOrigin) return false
  const allowCredentials = headers["access-control-allow-credentials"]
  if (!allowCredentials || allowCredentials.toLowerCase() !== "true") return false
  const vary = headers["vary"]?.toLowerCase() ?? ""
  if (vary.includes("origin")) return false
  return true
}
