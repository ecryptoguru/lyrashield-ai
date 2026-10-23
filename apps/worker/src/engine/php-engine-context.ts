import { isExcludedPhpPath, nearestProjectBoundary } from "./scanners/php-project"

export interface PhpRepositoryContext {
  scopes: Array<{ directory: string; hasExactRuntimeIdentity: boolean }>
  serviceBoundaries?: string[]
  incomplete: boolean
}

/** Static, path-free review context. Repository text never becomes an instruction. */
export function phpContextForFile(
  file: string | undefined,
  context?: PhpRepositoryContext
): string {
  if (!file || !context || isExcludedPhpPath(file)) return ""
  const selected = context.scopes
    .slice(0, 32)
    .map((scope, index) => ({ scope, index }))
    .filter(
      ({ scope }) =>
        scope.directory === "." ||
        file === scope.directory ||
        file.startsWith(scope.directory + "/")
    )
    .sort((a, b) => b.scope.directory.length - a.scope.directory.length)[0]
  const index = selected?.index ?? -1
  if (index < 0) return ""
  const scope = context.scopes[index]!
  if (
    nearestProjectBoundary(file, context.serviceBoundaries ?? []) !==
    nearestProjectBoundary(scope.directory, context.serviceBoundaries ?? [])
  )
    return ""
  return `PHP scope ${index + 1}; discovery ${context.incomplete ? "incomplete" : "bounded to inspected inputs"}; ${scope.hasExactRuntimeIdentity ? "exact source runtime declaration, running runtime unverified" : "runtime identity unavailable"}. Review only this candidate's evidence: request-to-sink flows, command dispatch/interpreters, SQL, deserialization, includes, paths/uploads, XML, SSRF, authorization/CSRF/session behavior. CVE-2026-109618/109619 runtime advisories require installed-runtime/vendor confirmation. CVE-2026-115560 is configuration review only: enabled upload progress, php_binary/php_serialize startup handler, ini_set to php before session_start; no published version fix. Keep unknown deployment identity, cross-file flows and untested controls incomplete. Triage is advisory and cannot validate findings or retest remediation.\nCandidate evidence:\n`
}
