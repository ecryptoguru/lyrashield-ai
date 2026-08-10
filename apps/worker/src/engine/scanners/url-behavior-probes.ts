import {
  redactUrlForLogs,
  safeFetchDetailed,
  type HostResolver,
  type SurfaceCollection,
  type SurfaceCollectionIssue,
  type SurfaceSignal,
  type SurfaceSubject,
} from "@lyrashield/security"
import { logger } from "@lyrashield/logger"

export type UrlBehaviorProbeResult = {
  signals: SurfaceSignal[]
  subjects: SurfaceSubject[]
  issues: SurfaceCollectionIssue[]
}

function issue(
  code: SurfaceCollectionIssue["code"],
  subject: string,
  reason: string
): SurfaceCollectionIssue {
  return {
    code,
    subject: redactUrlForLogs(subject),
    reason,
  }
}

function probeSubject(
  url: string,
  method: "GET" | "HEAD" | "OPTIONS",
  result: {
    finalUrl: string
    urlHistory: string[]
    status: number
    headers: Record<string, string>
  },
  depth: number
): SurfaceSubject {
  return {
    kind: "probe",
    requestedUrl: redactUrlForLogs(url),
    finalUrl: redactUrlForLogs(result.finalUrl),
    urlHistory: result.urlHistory.map(redactUrlForLogs),
    method,
    status: result.status,
    headers: result.headers,
    body: "",
    bodyBytes: 0,
    bodyTruncated: false,
    depth,
  }
}

function isReflectedCors(
  headers: Record<string, string>,
  sentOrigin: string
): boolean {
  const allowOrigin = headers["access-control-allow-origin"]
  if (!allowOrigin) return false
  if (allowOrigin === "*") return false
  if (allowOrigin !== sentOrigin) return false
  const allowCredentials = headers["access-control-allow-credentials"]
  if (!allowCredentials || allowCredentials.toLowerCase() !== "true") return false
  const vary = headers["vary"]?.toLowerCase() ?? ""
  if (vary.includes("origin")) return false
  return true
}

function corsSignal(url: string, headers: Record<string, string>): SurfaceSignal {
  return {
    id: `surface.cors-reflected-credentials.${url}`,
    subjectUrl: redactUrlForLogs(url),
    controlIds: [14],
    state: "DETECTED",
    severity: "MEDIUM",
    title: "CORS allows a reflected origin with credentials",
    description:
      "The response echoes the request Origin and sets Access-Control-Allow-Credentials: true without a Vary: Origin header, allowing credentialed cross-origin access from an arbitrary origin.",
    evidence: {
      allowOrigin: headers["access-control-allow-origin"] ?? "",
      allowCredentials: headers["access-control-allow-credentials"] ?? "",
      vary: headers["vary"] ?? "",
    },
  }
}

const PROBE_USER_AGENT = "LyraShield-BehaviorProbe/2.0"
const PROBE_ORIGIN = "https://lyrashield.invalid"

export async function runUrlBehaviorProbes(options: {
  collection: SurfaceCollection
  fetchFn?: typeof fetch
  resolver?: HostResolver
  signal?: AbortSignal
}): Promise<UrlBehaviorProbeResult> {
  const { collection, fetchFn, resolver, signal } = options
  const profile = collection.profile

  const signals: SurfaceSignal[] = []
  const subjects: SurfaceSubject[] = []
  const issues: SurfaceCollectionIssue[] = []

  if (profile.id !== "WEB_APP_DEEP") {
    return { signals, subjects, issues }
  }

  const documents = collection.subjects
    .filter((s) => s.kind === "document")
    .sort((a, b) => a.requestedUrl.localeCompare(b.requestedUrl))

  if (documents.length === 0) {
    return { signals, subjects, issues }
  }

  let methodProbesUsed = 0
  let originProbesUsed = 0

  for (const document of documents) {
    if (signal?.aborted) {
      issues.push(issue("LIMIT_REACHED", document.requestedUrl, "Scan wall-time budget was exhausted."))
      break
    }

    if (methodProbesUsed >= profile.maxMethodProbes && originProbesUsed >= profile.maxOriginProbes) {
      issues.push(
        issue(
          "LIMIT_REACHED",
          document.requestedUrl,
          `Behavior probe budget reached (${profile.maxMethodProbes} method probes, ${profile.maxOriginProbes} origin probes).`
        )
      )
      break
    }

    const url = document.requestedUrl

    if (methodProbesUsed < profile.maxMethodProbes) {
      for (const method of ["HEAD", "OPTIONS"] as const) {
        if (methodProbesUsed >= profile.maxMethodProbes) break
        if (signal?.aborted) break

        const outcome = await safeFetchDetailed(url, {
          method,
          maxBytes: 0,
          userAgent: PROBE_USER_AGENT,
          fetchFn,
          resolver,
          signal,
        })

        if (!outcome.ok) {
          if (signal?.aborted) {
            issues.push(issue("LIMIT_REACHED", url, "Scan wall-time budget was exhausted."))
          } else {
            issues.push(issue("FETCH_FAILED", url, `Behavior ${method} probe failed: ${outcome.reason}`))
          }
          continue
        }

        subjects.push(probeSubject(url, method, outcome.result, document.depth))
        methodProbesUsed++
      }
    }

    if (originProbesUsed < profile.maxOriginProbes) {
      if (signal?.aborted) {
        issues.push(issue("LIMIT_REACHED", url, "Scan wall-time budget was exhausted."))
        break
      }

      const outcome = await safeFetchDetailed(url, {
        method: "GET",
        origin: PROBE_ORIGIN,
        maxBytes: 0,
        userAgent: PROBE_USER_AGENT,
        fetchFn,
        resolver,
        signal,
      })

      if (!outcome.ok) {
        if (signal?.aborted) {
          issues.push(issue("LIMIT_REACHED", url, "Scan wall-time budget was exhausted."))
        } else {
          issues.push(issue("FETCH_FAILED", url, `Behavior origin probe failed: ${outcome.reason}`))
        }
        continue
      }

      subjects.push(probeSubject(url, "GET", outcome.result, document.depth))
      originProbesUsed++

      if (isReflectedCors(outcome.result.headers, PROBE_ORIGIN)) {
        signals.push(corsSignal(url, outcome.result.headers))
      }
    }
  }

  logger.info("URL behavior probes complete", {
    documents: documents.length,
    methodProbes: methodProbesUsed,
    originProbes: originProbesUsed,
    signals: signals.length,
  })

  return { signals, subjects, issues }
}
