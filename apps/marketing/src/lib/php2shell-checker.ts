import { assessPhpRuntimeVersion } from "@lyrashield/security/php-security"

export type Answer = "yes" | "no" | "unknown"
export type Serializer = "php" | "php_binary" | "php_serialize" | "unknown"
export type PhpCheckInput = {
  version: string
  source: "web" | "cli" | "declaration" | "unknown"
  deployment: "managed" | "container" | "vendor" | "unknown"
  backport: boolean
  uploadProgress?: Answer
  serializer?: Serializer
  switchesHandler?: Answer
}

export const PHP_CHECK_RULES = "php2shell-guided/2026-10-24.1"
export const PHP_CHECK_SOURCE = "https://www.php.net/archive/2026.php"

export function assessSessionNotice(
  upload: Answer,
  serializer: Serializer,
  switchesHandler: Answer
) {
  if (upload === "no" || serializer === "php" || switchesHandler === "no") {
    return {
      status: "not-indicated" as const,
      title: "A reported prerequisite is absent",
      guidance:
        "The October 23 notice's configuration combination is not indicated by these answers. Confirm the effective startup configuration on every serving worker; these answers do not verify effective configuration.",
    }
  }
  if (upload === "yes" && serializer !== "unknown" && switchesHandler === "yes") {
    return {
      status: "review" as const,
      title: "Reported configuration needs action",
      guidance:
        "Your answers match the configuration combination in the October 23 notice. Set session.upload_progress.enabled=0 in startup configuration and restart every worker. Check PHP's notice for the next regular bugfix release; no fixed version is asserted here.",
    }
  }
  return {
    status: "unknown" as const,
    title: "Session configuration needs review",
    guidance:
      "CVE-2026-115560 needs a separate configuration review even on the original PHP2Shell patched releases. Check effective upload-progress settings, the configured serializer and runtime changes before session_start(). PHP recommends disabling session upload progress until its next regular bugfix release.",
  }
}

export function assessPhp2Shell(input: PhpCheckInput) {
  const runtime = assessPhpRuntimeVersion(input.version.trim())
  const notes = [
    "All information is user-reported. This assessment does not verify a deployed runtime, exploitability or prior compromise.",
  ]
  if (input.source === "cli")
    notes.push(
      "CLI PHP can differ from the web runtime. Read back the version from the serving FPM, Apache or other web worker through authorized administrative access."
    )
  else if (input.source !== "web")
    notes.push(
      "A source declaration or unknown identity cannot establish the version running on your website. Obtain the serving runtime identity from your host or deployment administrator."
    )
  if (input.backport)
    notes.push(
      "A vendor backport claim needs vendor advisory and exact package-revision evidence. The upstream version match is retained until that evidence is independently reviewed."
    )
  const steps: string[] = []
  if (runtime.status === "affected")
    steps.push(
      `Update the affected runtime to ${runtime.fixedVersion} or a later maintained release in the same branch, or obtain a vendor-confirmed fixed package. Review application compatibility first.`
    )
  else if (runtime.status === "fixed")
    steps.push(
      "The entered version meets the original two advisories' upstream patch threshold. Confirm the installed package or image and review CVE-2026-115560 separately."
    )
  else
    steps.push(
      "Obtain an exact supported PHP version in major.minor.patch form. Unsupported or unrecognized versions need a PHP/vendor advisory review; they cannot receive a clean result."
    )
  if (input.deployment === "managed")
    steps.push(
      "Ask your hosting provider to confirm the fixed package, affected site/pool, rollout time and replacement of all serving workers. A WordPress or plugin update alone does not patch PHP."
    )
  else if (input.deployment === "container")
    steps.push(
      "Rebuild with the reviewed patched base image, verify its immutable digest, test the application and roll out the new image to every replica. A Dockerfile edit alone does not replace running containers."
    )
  else if (input.deployment === "vendor")
    steps.push(
      "Use your distribution or vendor security advisory to select the exact fixed package revision. Test and deploy through your normal release process."
    )
  else
    steps.push(
      "Identify who operates the runtime, then follow the hosting, vendor-package or container update process for that deployment."
    )
  steps.push(
    "Replace or restart every affected web worker and replica, including older deployments and background services. Read back runtime/package identity through authorized administrative access. Do not expose a public phpinfo endpoint."
  )
  steps.push(
    "Run a fresh authorized scan and retain deployment evidence. Investigate suspected prior compromise separately: patching does not remove a webshell or rotate stolen credentials."
  )
  return {
    rules: PHP_CHECK_RULES,
    verified: false as const,
    runtime,
    session: assessSessionNotice(
      input.uploadProgress ?? "unknown",
      input.serializer ?? "unknown",
      input.switchesHandler ?? "unknown"
    ),
    notes,
    steps,
  }
}
