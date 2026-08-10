import { parse as parseYaml } from "yaml"
import { logger } from "@lyrashield/logger"
import {
  safeFetchDetailed,
  redactUrlForLogs,
  type HostResolver,
  type SurfaceCollectionIssue,
  type SurfaceSignal,
  type SurfaceSubject,
} from "@lyrashield/security"
import { type UrlRequestMethod, type UrlScanProfile, type UrlExecutionSummary } from "@lyrashield/types"
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
  paths?: Record<string, OpenApiPathItem>
  components?: unknown
}

type OpenApiPathItem = Partial<
  Record<
    "get" | "head" | "options" | "post" | "put" | "patch" | "delete",
    OpenApiOperation
  >
>

type OpenApiOperation = {
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

function buildEmptyExecution(profile: UrlScanProfile, issueCodes: string[] = []): UrlExecutionSummary {
  return {
    contractVersion: "url-scan/2.0.0",
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

const ALL_SAFE_METHODS: UrlRequestMethod[] = ["GET", "HEAD", "OPTIONS"]

const METHOD_TO_KEY: Record<UrlRequestMethod, "get" | "head" | "options"> = {
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

function urlOrigin(url: string): string {
  return new URL(url).origin
}

function resolveServer(spec: OpenApiSpec, targetUrl: string): string {
  const servers = spec.servers
  if (!servers || servers.length === 0) return targetUrl
  const candidate = servers[0]?.url
  if (!candidate) return targetUrl
  if (/^https?:\/\//.test(candidate)) return candidate
  // Relative server URL resolved against target origin.
  const base = new URL(targetUrl)
  return new URL(candidate, `${base.origin}/`).toString()
}

function operationHasAuth(operation: OpenApiOperation): boolean {
  if (operation.security && operation.security.length > 0) return true
  return false
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

function deepDeref(spec: OpenApiSpec, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => deepDeref(spec, v))
  }
  if (value && typeof value === "object") {
    if ("$ref" in value && typeof value.$ref === "string") {
      const resolved = resolveLocalRef(spec, value.$ref)
      return resolved !== undefined ? deepDeref(spec, resolved) : value
    }
    const result: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      result[key] = deepDeref(spec, v)
    }
    return result
  }
  return value
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

function operationRequiresParams(operation: OpenApiOperation): boolean {
  if (!operation.parameters || operation.parameters.length === 0) return false
  for (const param of operation.parameters) {
    if (param.in === "header" || param.in === "cookie") return true
    if (isSensitiveParamName(param.name)) return true
    if (param.in === "query" && param.required && getExampleValue(param) === undefined) return true
  }
  return false
}

function buildOperationUrl(
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

function validateResponseContent(
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

function toEngineVulnerability(signal: SurfaceSignal): EngineVulnerability {
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

function operationSignal(
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

function authRequiredSignal(operation: OpenApiOperationAttempt): SurfaceSignal {
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

function isReflectedCors(
  headers: Record<string, string>,
  sentOrigin: string
): boolean {
  const allowOrigin = headers["access-control-allow-origin"]
  if (!allowOrigin || allowOrigin === "*") return false
  if (allowOrigin !== sentOrigin) return false
  const allowCredentials = headers["access-control-allow-credentials"]
  if (!allowCredentials || allowCredentials.toLowerCase() !== "true") return false
  const vary = headers["vary"]?.toLowerCase() ?? ""
  if (vary.includes("origin")) return false
  return true
}

export async function scanOpenApi(options: {
  targetUrl: string
  apiSpecUrl: string
  profile: UrlScanProfile
  fetchFn?: typeof fetch
  resolver?: HostResolver
  signal?: AbortSignal
}): Promise<OpenApiScannerResult> {
  const { targetUrl, apiSpecUrl, profile, fetchFn, resolver, signal } = options

  const signals: SurfaceSignal[] = []
  const subjects: SurfaceSubject[] = []
  const issues: SurfaceCollectionIssue[] = []
  const attemptedOperations: OpenApiOperationAttempt[] = []

  if (signal?.aborted) {
    issues.push({
      code: "LIMIT_REACHED",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: "Scan was cancelled before the OpenAPI contract could be fetched.",
    })
    return { findings: [], signals, subjects, issues, attemptedOperations, execution: buildEmptyExecution(profile, issues.map((i) => i.code)) }
  }

  const specOutcome = await safeFetchDetailed(apiSpecUrl, {
    maxBytes: profile.maxResponseBytes,
    userAgent: "LyraShield-OpenApi-Scanner/2.0",
    fetchFn,
    resolver,
    signal,
  })

  if (!specOutcome.ok) {
    issues.push({
      code: "FETCH_FAILED",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: `Could not fetch OpenAPI spec: ${specOutcome.reason}`,
    })
    return { findings: [], signals, subjects, issues, attemptedOperations, execution: buildEmptyExecution(profile, issues.map((i) => i.code)) }
  }

  const rawBody = specOutcome.result.html.trim()
  if (rawBody.length === 0) {
    issues.push({
      code: "UNSUPPORTED_CONTENT",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: "OpenAPI spec response body was empty.",
    })
    return { findings: [], signals, subjects, issues, attemptedOperations, execution: buildEmptyExecution(profile, issues.map((i) => i.code)) }
  }

  let parsed: unknown
  try {
    parsed = rawBody.startsWith("{") ? JSON.parse(rawBody) : parseYaml(rawBody)
  } catch {
    issues.push({
      code: "UNSUPPORTED_CONTENT",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: "OpenAPI spec could not be parsed as JSON or YAML.",
    })
    return { findings: [], signals, subjects, issues, attemptedOperations, execution: buildEmptyExecution(profile, issues.map((i) => i.code)) }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    issues.push({
      code: "UNSUPPORTED_CONTENT",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: "OpenAPI spec must be a JSON or YAML object.",
    })
    return { findings: [], signals, subjects, issues, attemptedOperations, execution: buildEmptyExecution(profile, issues.map((i) => i.code)) }
  }

  const spec = parsed as OpenApiSpec
  const openapiVersion = spec.openapi
  if (typeof openapiVersion !== "string" || !openapiVersion.startsWith("3.")) {
    issues.push({
      code: "UNSUPPORTED_CONTENT",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: "OpenAPI spec must be version 3.x.",
    })
    return { findings: [], signals, subjects, issues, attemptedOperations, execution: buildEmptyExecution(profile, issues.map((i) => i.code)) }
  }

  const paths = spec.paths ?? {}
  const pathNames = Object.keys(paths)
  if (pathNames.length > 500) {
    issues.push({
      code: "UNSUPPORTED_CONTENT",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: `OpenAPI spec declares ${pathNames.length} paths; the maximum supported is 500.`,
    })
    return { findings: [], signals, subjects, issues, attemptedOperations, execution: buildEmptyExecution(profile, issues.map((i) => i.code)) }
  }

  const baseServer = resolveServer(spec, targetUrl)
  const targetOrigin = urlOrigin(targetUrl)
  if (urlOrigin(baseServer) !== targetOrigin) {
    issues.push({
      code: "OUT_OF_SCOPE",
      subject: redactUrlForLogs(baseServer),
      reason: "OpenAPI server URL is not on the same origin as the target.",
    })
    return { findings: [], signals, subjects, issues, attemptedOperations, execution: buildEmptyExecution(profile, issues.map((i) => i.code)) }
  }

  // Build a sorted list of candidate operations. Safe methods fall back to the
  // GET operation definition when the spec does not explicitly declare them, so
  // every GET path is also probed with HEAD (and, in Deep, OPTIONS).
  const candidates: Array<{ path: string; method: UrlRequestMethod; operation: OpenApiOperation }> = []
  for (const path of pathNames.sort()) {
    const item = deepDeref(spec, paths[path]) as OpenApiPathItem | undefined
    if (!item) continue
    const methods = (profile.allowedMethods as UrlRequestMethod[]).filter((m) =>
      ALL_SAFE_METHODS.includes(m)
    )
    for (const method of methods) {
      const operation =
        item[METHOD_TO_KEY[method]] ??
        (method !== "GET" ? item.get : undefined)
      if (operation) {
        candidates.push({ path, method, operation: deepDeref(spec, operation) as OpenApiOperation })
      }
    }
  }

  const isDeep = profile.id === "API_DEEP"
  const maxOperations = profile.maxOperations
  const executed: Array<{ attempt: OpenApiOperationAttempt; headers: Record<string, string>; status: number }> = []
  let totalBytes = 0

  for (const candidate of candidates) {
    if (signal?.aborted) {
      issues.push({
        code: "LIMIT_REACHED",
        subject: redactUrlForLogs(targetUrl),
        reason: "Scan wall-time budget was exhausted.",
      })
      break
    }

    if (attemptedOperations.length >= maxOperations) {
      issues.push({
        code: "LIMIT_REACHED",
        subject: redactUrlForLogs(targetUrl),
        reason: `Operation budget reached (${maxOperations} operations).`,
      })
      break
    }

    if (operationHasAuth(candidate.operation)) {
      const url = new URL(candidate.path, baseServer).toString()
      const attempt: OpenApiOperationAttempt = {
        method: candidate.method,
        path: candidate.path,
        url,
      }
      attemptedOperations.push(attempt)
      issues.push({
        code: "AUTHENTICATION_REQUIRED",
        subject: redactUrlForLogs(url),
        reason: "Operation declares security requirements and cannot be probed without credentials.",
      })
      signals.push(authRequiredSignal(attempt))
      continue
    }

    if (operationRequiresParams(candidate.operation)) {
      const url = new URL(candidate.path, baseServer).toString()
      issues.push({
        code: "PARAMETER_VALUE_UNAVAILABLE",
        subject: redactUrlForLogs(url),
        reason: "Operation requires parameters and cannot be probed without documented values.",
      })
      continue
    }

    const { url, issues: buildIssues } = buildOperationUrl(
      baseServer,
      candidate.path,
      candidate.operation.parameters ?? []
    )
    issues.push(...buildIssues)

    // Verify the built URL stays on the target origin.
    if (urlOrigin(url) !== targetOrigin) {
      issues.push({
        code: "OUT_OF_SCOPE",
        subject: redactUrlForLogs(url),
        reason: "Resolved operation URL leaves the target origin.",
      })
      continue
    }

    if (buildIssues.some((i) => i.code === "PARAMETER_VALUE_UNAVAILABLE")) {
      continue
    }

    const attempt: OpenApiOperationAttempt = {
      method: candidate.method,
      path: candidate.path,
      url,
    }
    attemptedOperations.push(attempt)

    const outcome = await safeFetchDetailed(url, {
      method: candidate.method,
      maxBytes: profile.maxResponseBytes,
      userAgent: "LyraShield-OpenApi-Scanner/2.0",
      fetchFn,
      resolver,
      signal,
    })

    if (!outcome.ok) {
      issues.push({
        code: "FETCH_FAILED",
        subject: redactUrlForLogs(url),
        reason: `Operation probe failed: ${outcome.reason}`,
      })
      continue
    }

    const { status, headers, bodyBytes, finalUrl } = outcome.result
    totalBytes += bodyBytes

    subjects.push({
      kind: "api_operation",
      requestedUrl: redactUrlForLogs(url),
      finalUrl: redactUrlForLogs(finalUrl),
      urlHistory: [redactUrlForLogs(url)],
      method: candidate.method,
      status,
      headers,
      body: "",
      bodyBytes: 0,
      bodyTruncated: false,
      depth: 0,
    })

    const contentType = headers["content-type"]
    const { issues: responseIssues, schemaUnsupported } = validateResponseContent(
      url,
      status,
      contentType,
      candidate.operation
    )
    issues.push(...responseIssues)

    if (!schemaUnsupported) {
      executed.push({ attempt, headers, status })
      signals.push(operationSignal(attempt, status, contentType))
    }
  }

  // Deep behavior: bounded origin probes for CORS on executed GET operations.
  if (isDeep && executed.length > 0) {
    const originProbeUrl = "https://lyrashield.invalid"
    const getOps = executed.filter((e) => e.attempt.method === "GET").slice(0, profile.maxOriginProbes)
    for (const { attempt } of getOps) {
      if (signal?.aborted) break

      const corsOutcome = await safeFetchDetailed(attempt.url, {
        method: "GET",
        origin: originProbeUrl,
        maxBytes: 0,
        userAgent: "LyraShield-OpenApi-Scanner/2.0",
        fetchFn,
        resolver,
        signal,
      })

      if (!corsOutcome.ok) continue

      const probeSubject: SurfaceSubject = {
        kind: "probe",
        requestedUrl: redactUrlForLogs(attempt.url),
        finalUrl: redactUrlForLogs(corsOutcome.result.finalUrl),
        urlHistory: [redactUrlForLogs(attempt.url)],
        method: "GET",
        status: corsOutcome.result.status,
        headers: corsOutcome.result.headers,
        body: "",
        bodyBytes: 0,
        bodyTruncated: false,
        depth: 0,
      }
      subjects.push(probeSubject)

      if (isReflectedCors(corsOutcome.result.headers, originProbeUrl)) {
        signals.push({
          id: `surface.cors-reflected-credentials.${redactUrlForLogs(attempt.url)}`,
          subjectUrl: redactUrlForLogs(attempt.url),
          controlIds: [14],
          state: "DETECTED",
          severity: "MEDIUM",
          title: "CORS allows a reflected origin with credentials",
          description:
            "The response echoes the request Origin and sets Access-Control-Allow-Credentials: true without a Vary: Origin header, allowing credentialed cross-origin access from an arbitrary origin.",
          evidence: {
            allowOrigin: corsOutcome.result.headers["access-control-allow-origin"] ?? "",
            allowCredentials: corsOutcome.result.headers["access-control-allow-credentials"] ?? "",
            vary: corsOutcome.result.headers["vary"] ?? "",
          },
        })
      }
    }
  }

  if (totalBytes >= profile.maxTotalBytes) {
    issues.push({
      code: "LIMIT_REACHED",
      subject: redactUrlForLogs(targetUrl),
      reason: `Total response byte budget reached (${profile.maxTotalBytes} bytes).`,
    })
  }

  // Spec subject: aggregate scope, not the raw spec.
  subjects.push({
    kind: "api_spec",
    requestedUrl: redactUrlForLogs(apiSpecUrl),
    finalUrl: redactUrlForLogs(apiSpecUrl),
    urlHistory: [redactUrlForLogs(apiSpecUrl)],
    method: "GET",
    status: specOutcome.result.status,
    headers: specOutcome.result.headers,
    body: "",
    bodyBytes: 0,
    bodyTruncated: true,
    depth: 0,
  })

  const findings = signals.filter((s) => s.state === "DETECTED").map(toEngineVulnerability)

  const operationSubjects = subjects.filter((s) => s.kind === "api_operation")
  const methodProbeSubjects = subjects.filter((s) => s.kind === "probe" && s.method !== "GET")
  const originProbeSubjects = subjects.filter((s) => s.kind === "probe" && s.method === "GET")

  const execution: UrlExecutionSummary = {
    contractVersion: "url-scan/2.0.0",
    profile: profile.id,
    methods: [...new Set(profile.allowedMethods)].sort() as UrlRequestMethod[],
    subjectCount: subjects.length,
    documentCount: 0,
    assetCount: 0,
    operationCount: operationSubjects.length,
    methodProbeCount: methodProbeSubjects.length,
    originProbeCount: originProbeSubjects.length,
    totalBytes,
    truncated: totalBytes >= profile.maxTotalBytes,
    issueCodes: [...new Set(issues.map((i) => i.code))].sort(),
  }

  logger.info("OpenAPI contract scan complete", {
    targetUrl: redactUrlForLogs(targetUrl),
    apiSpecUrl: redactUrlForLogs(apiSpecUrl),
    operations: attemptedOperations.length,
    findings: findings.length,
    signals: signals.length,
    issues: issues.length,
  })

  return { findings, signals, subjects, issues, attemptedOperations, execution }
}
