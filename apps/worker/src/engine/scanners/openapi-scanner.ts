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
import {
  URL_SCAN_CONTRACT_VERSION,
  type UrlRequestMethod,
  type UrlScanProfile,
  type UrlExecutionSummary,
} from "@lyrashield/types"
import {
  ALL_SAFE_METHODS,
  METHOD_TO_KEY,
  authRequiredSignal,
  buildEmptyExecution,
  buildOperationUrl,
  deepDeref,
  isReflectedCors,
  mergeParameters,
  operationHasAuth,
  operationRequiresParams,
  operationSignal,
  resolveServer,
  toEngineVulnerability,
  urlOrigin,
  validateResponseContent,
  type OpenApiOperation,
  type OpenApiOperationAttempt,
  type OpenApiPathItem,
  type OpenApiScannerResult,
  type OpenApiSpec,
} from "./openapi-scanner-support"

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
  const emptyResult = (): OpenApiScannerResult => ({
    findings: [],
    signals,
    subjects,
    issues,
    attemptedOperations,
    execution: buildEmptyExecution(
      profile,
      issues.map((issue) => issue.code)
    ),
  })

  if (signal?.aborted) {
    issues.push({
      code: "LIMIT_REACHED",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: "Scan was cancelled before the OpenAPI contract could be fetched.",
    })
    return emptyResult()
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
    return emptyResult()
  }

  const rawBody = specOutcome.result.html.trim()
  if (rawBody.length === 0) {
    issues.push({
      code: "UNSUPPORTED_CONTENT",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: "OpenAPI spec response body was empty.",
    })
    return emptyResult()
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
    return emptyResult()
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    issues.push({
      code: "UNSUPPORTED_CONTENT",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: "OpenAPI spec must be a JSON or YAML object.",
    })
    return emptyResult()
  }

  const spec = parsed as OpenApiSpec
  const openapiVersion = spec.openapi
  if (typeof openapiVersion !== "string" || !openapiVersion.startsWith("3.")) {
    issues.push({
      code: "UNSUPPORTED_CONTENT",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: "OpenAPI spec must be version 3.x.",
    })
    return emptyResult()
  }

  const paths = spec.paths ?? {}
  const pathNames = Object.keys(paths)
  if (pathNames.length > 500) {
    issues.push({
      code: "UNSUPPORTED_CONTENT",
      subject: redactUrlForLogs(apiSpecUrl),
      reason: `OpenAPI spec declares ${pathNames.length} paths; the maximum supported is 500.`,
    })
    return emptyResult()
  }

  const baseServer = resolveServer(spec, targetUrl)
  const targetOrigin = urlOrigin(targetUrl)
  if (urlOrigin(baseServer) !== targetOrigin) {
    issues.push({
      code: "OUT_OF_SCOPE",
      subject: redactUrlForLogs(baseServer),
      reason: "OpenAPI server URL is not on the same origin as the target.",
    })
    return emptyResult()
  }

  // Build a sorted list of candidate operations. Safe methods fall back to the
  // GET operation definition when the spec does not explicitly declare them, so
  // every GET path is also probed with HEAD (and, in Deep, OPTIONS).
  const candidates: Array<{ path: string; method: UrlRequestMethod; operation: OpenApiOperation }> =
    []
  for (const path of pathNames.sort()) {
    const item = deepDeref(spec, paths[path]) as OpenApiPathItem | undefined
    if (!item) continue
    const methods = (profile.allowedMethods as UrlRequestMethod[]).filter((m) =>
      ALL_SAFE_METHODS.includes(m)
    )
    for (const method of methods) {
      const operation = item[METHOD_TO_KEY[method]] ?? (method !== "GET" ? item.get : undefined)
      if (operation) {
        const resolvedOperation = deepDeref(spec, operation) as OpenApiOperation
        candidates.push({
          path,
          method,
          operation: {
            ...resolvedOperation,
            parameters: mergeParameters(item.parameters, resolvedOperation.parameters),
          },
        })
      }
    }
  }

  const isDeep = profile.id === "API_DEEP"
  const maxOperations = profile.maxOperations
  const executed: Array<{
    attempt: OpenApiOperationAttempt
    headers: Record<string, string>
    status: number
  }> = []
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

    if (operationHasAuth(candidate.operation, spec.security)) {
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
        reason:
          "Operation declares security requirements and cannot be probed without credentials.",
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
    const getOps = executed
      .filter((e) => e.attempt.method === "GET")
      .slice(0, profile.maxOriginProbes)
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
    contractVersion: URL_SCAN_CONTRACT_VERSION,
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
