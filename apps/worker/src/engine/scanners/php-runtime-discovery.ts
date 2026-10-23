import { dirname, relative } from "node:path"
import type { IacFileKind } from "./iac-rules"
import { isExcludedPhpPath, nearestProjectBoundary } from "./php-project"
import { discoverPhpRuntimeInput, inspectPhpRuntimeInput } from "./php-runtime"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"
import type { PhpRepositoryContext } from "../php-engine-context"

/** Shares the existing IaC walk and parsed inputs; never traverses or reads a file. */
export function createPhpRuntimeDiscovery(
  workspaceDir: string,
  sourceDirectories: Set<string>,
  issues?: ScannerCoverageIssue[],
  serviceDirectories = new Set<string>()
) {
  const scopeDirectories = new Set(sourceDirectories)
  const identityDirectories = new Set<string>()
  const covered = (directory: string) =>
    [...identityDirectories].some(
      (identity) =>
        (directory === identity || directory.startsWith(identity + "/")) &&
        nearestProjectBoundary(directory, serviceDirectories) ===
          nearestProjectBoundary(identity, serviceDirectories)
    )
  return {
    inspect(path: string, filePath: string, content: string, kind: IacFileKind | null) {
      const detected = isExcludedPhpPath(path)
        ? undefined
        : discoverPhpRuntimeInput(path, content, kind)
      const scopedSource = [...sourceDirectories].some(
        (sourceDir) =>
          sourceDir === dirname(filePath) || sourceDir.startsWith(dirname(filePath) + "/")
      )
      if (detected && !detected.phpPresent && !scopedSource)
        for (const issue of detected.issues) recordCoverageIssue(issues, issue)
      const runtime =
        detected && (detected.phpPresent || scopedSource)
          ? inspectPhpRuntimeInput(path, content, kind, issues, detected)
          : { findings: [], hasIdentity: false, phpPresent: false }
      if (runtime.phpPresent) scopeDirectories.add(dirname(filePath))
      if (runtime.hasIdentity) identityDirectories.add(dirname(filePath))
      return runtime
    },
    finish(incomplete: boolean): PhpRepositoryContext | undefined {
      if (scopeDirectories.size === 0) return undefined
      const missingIdentity = [...scopeDirectories].some((directory) => !covered(directory))
      if (missingIdentity)
        recordCoverageIssue(issues, {
          scanner: "iac",
          status: "partial",
          reason:
            "PHP sources/declarations were found without usable exact runtime identity; runtime advisory coverage is incomplete",
        })
      return {
        serviceBoundaries: [...serviceDirectories]
          .sort()
          .slice(0, 64)
          .map((directory) => relative(workspaceDir, directory) || "."),
        scopes: [...(serviceDirectories.size > 64 ? [] : scopeDirectories)]
          .sort()
          .slice(0, 32)
          .map((directory) => ({
            directory: relative(workspaceDir, directory) || ".",
            hasExactRuntimeIdentity: covered(directory),
          })),
        incomplete:
          incomplete ||
          missingIdentity ||
          scopeDirectories.size > 32 ||
          serviceDirectories.size > 64 ||
          issues?.some((issue) => issue.scanner === "iac") === true,
      }
    },
  }
}
