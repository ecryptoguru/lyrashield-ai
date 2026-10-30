// security-scan-skip-file: passive version and configuration detection rules
import { basename } from "node:path"
import {
  PHP_SESSION_UPLOAD_PROGRESS_NOTICE,
  matchPhpRuntimeAdvisories,
} from "@lyrashield/security/php-security"
import { z } from "zod"
import { isScalar, LineCounter, parseDocument } from "yaml"
import { parsePhpVersionFile } from "./php-runtime-declarations"
import {
  PHP_RUNTIME_CATALOG,
  branchOf,
  patchOf,
  exactVersion,
  versionSchema,
} from "./php-runtime-catalog"
import type { EngineVulnerability } from "../output-parser"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"

const officialImagePattern =
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, delimiter-separated fields on byte-bounded input
  /^(?:(?:docker\.io\/)?library\/|docker\.io\/)?php:(\d+\.\d+\.\d+)(-(?:apache|fpm|cli|zts)(?:-(?:alpine(?:[1-9]\d?(?:\.(?:0|[1-9]\d?))?)?|bookworm|bullseye|trixie))?|-(?:alpine(?:[1-9]\d?(?:\.(?:0|[1-9]\d?))?)?|bookworm|bullseye|trixie))?(?:@sha256:[a-f0-9]{64})?$/

const inventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    version: versionSchema,
    sapi: z.enum(["cli", "fpm", "cgi", "apache2handler", "frankenphp", "litespeed"]).optional(),
    extensions: z
      .array(z.string().regex(/^[a-z0-9_]{1,64}$/))
      .max(128)
      .refine((extensions) => new Set(extensions).size === extensions.length, "duplicate extension")
      .optional(),
    os: z.enum(["linux", "windows", "other"]).optional(),
    image: z.string().min(1).max(256).optional(),
    vendorPackage: z.string().min(1).max(256).optional(),
    windowsPackage: z
      .object({ origin: z.enum(["php.net", "other"]), build: z.string().min(1).max(64) })
      .strict()
      .optional(),
    backports: z
      .array(z.string().regex(/^(?:CVE-\d{4}-\d{4,8}|GHSA-[a-z0-9-]+)$/))
      .max(64)
      .optional(),
    replicas: z.number().int().min(1).max(100000).optional(),
  })
  .strict()
type Inventory = z.infer<typeof inventorySchema>
type Declaration = Partial<Inventory> & {
  version: string
  scope: "source_declaration" | "user_reported"
  line: number
  image?: string
  mutableImage?: string
  composeService?: string
}

function parseIdentityJson(content: string): unknown {
  const parsed: unknown = JSON.parse(content)
  const document = parseDocument(content, { uniqueKeys: true, strict: true })
  if (document.errors.length) throw new Error("ambiguous JSON identity")
  return parsed
}

export function isPhpRuntimeInput(name: string): boolean {
  return /^(?:composer\.json|php-runtime\.json|php\.ini|project\.toml|\.php-version)$/i.test(name)
}

function addImageDeclaration(
  image: string,
  line: number,
  editable: boolean,
  declarations: Declaration[],
  issue: (reason: string) => void,
  composeService?: string
): boolean {
  let phpPresent = false
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, delimiter-separated fields on byte-bounded input
  const official = /^(?:(?:docker\.io\/)?library\/|docker\.io\/)?php(?=:|@|$)/.test(image)
  if (!official) {
    if (/php/i.test(image)) {
      phpPresent = true
      issue(
        "PHP runtime identity is unknown for this custom image; image naming is not runtime evidence"
      )
    }
    return phpPresent
  }
  phpPresent = true
  const match = officialImagePattern.exec(image)
  if (!match || !exactVersion.test(match[1]!)) {
    issue(
      "PHP runtime identity requires an exact stable version; floating, variable, pre-release or malformed image declaration"
    )
    return phpPresent
  }
  declarations.push({
    version: match[1]!,
    scope: "source_declaration",
    line,
    image,
    composeService,
    mutableImage: editable && !image.includes("@") ? image : undefined,
    sapi: match[2]?.startsWith("-fpm")
      ? "fpm"
      : match[2]?.startsWith("-cli")
        ? "cli"
        : match[2]?.startsWith("-apache")
          ? "apache2handler"
          : undefined,
    os: "linux",
  })
  return phpPresent
}

/** Recognize instruction starts, never FROM text in shell continuations/heredocs. */
function dockerImageDeclarations(content: string, issue: (reason: string) => void) {
  const result: { image: string; line: number }[] = []
  const heredocs: { delimiter: string; stripTabs: boolean }[] = []
  let continued = false
  let header = true
  const directives = new Set<string>()
  let escape = "\\"
  for (const [i, line] of content.split("\n").entries()) {
    const pending = heredocs[0]
    if (pending) {
      const text = pending.stripTabs ? line.replace(/^\t+/, "") : line
      if (text.replace(/\r$/, "") === pending.delimiter) heredocs.shift()
      continue
    }
    // Docker stops recognizing directives after a normal comment, blank or instruction.
    if (header) {
      const directive = /^#\s*(syntax|check|escape)[ \t]*=/.exec(line.trimStart().toLowerCase())
      if (directive) {
        const key = directive[1]!.toLowerCase()
        const value = line.trimStart().slice(directive[0].length).trim()
        if (directives.has(key) || (key === "escape" && value !== "\\" && value !== "`")) {
          issue("PHP runtime Dockerfile parser directive is invalid or duplicated")
          break
        }
        directives.add(key)
        if (key === "escape") escape = value
        continue
      }
      header = false
    }
    if (/^\s*(?:#|$)/.test(line)) continue
    const wasContinued = continued
    continued = line.trimEnd().endsWith(escape)
    if (!wasContinued && !continued) {
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored, delimiter-separated fields on byte-bounded input
      const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line)
      if (match) result.push({ image: match[1]!, line: i + 1 })
    } else if (!wasContinued && /^\s*FROM\b/i.test(line)) {
      issue("PHP runtime multiline FROM declaration requires independent inventory")
    }
    // Conservative recognition: unrecognized delimiters stop further interpretation.
    const starts = [
      ...line.matchAll(
        /<<(-?)(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/g
      ),
    ]
    if (line.includes("<<") && starts.length === 0) {
      issue("PHP runtime Dockerfile heredoc syntax is unsupported")
      break
    }
    for (const start of starts)
      heredocs.push({ delimiter: (start[2] ?? start[3] ?? start[4])!, stripTabs: start[1] === "-" })
  }
  if (heredocs.length || continued) issue("PHP runtime Dockerfile has an incomplete instruction")
  return result
}

function phpConfigurationFindings(
  path: string,
  content: string,
  issues?: ScannerCoverageIssue[]
): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  // A source configuration can justify review, never a verified runtime CVE claim.
  const settings = new Map<string, { value: string; line: number }>()
  for (const [index, line] of content.split("\n").entries()) {
    const setting =
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored, delimiter-separated fields on byte-bounded input
      /^\s*(session\.(?:upload_progress\.enabled|serialize_handler))\s*=\s*["']?([a-z0-9_]+)["']?\s*(?:;.*)?$/i.exec(
        line
      )
    if (setting)
      settings.set(setting[1]!.toLowerCase(), {
        value: setting[2]!.toLowerCase(),
        line: index + 1,
      })
  }
  const handler = settings.get("session.serialize_handler")
  const upload = settings.get("session.upload_progress.enabled")
  if (
    handler &&
    ["php_binary", "php_serialize"].includes(handler.value) &&
    (!upload || ["1", "on", "true", "yes"].includes(upload.value))
  ) {
    findings.push({
      id: `php-config-${PHP_SESSION_UPLOAD_PROGRESS_NOTICE.id}-${path}`,
      title: "PHP session upload progress: configuration review",
      severity: "info",
      timestamp: new Date().toISOString(),
      target: path,
      scannerSource: "iac",
      cve: PHP_SESSION_UPLOAD_PROGRESS_NOTICE.id,
      finding_class: "php_runtime_config",
      description: PHP_SESSION_UPLOAD_PROGRESS_NOTICE.description,
      technical_analysis: PHP_SESSION_UPLOAD_PROGRESS_NOTICE.url,
      remediation_steps: PHP_SESSION_UPLOAD_PROGRESS_NOTICE.remediation,
      dependency_metadata: {
        evidence_scope: "source_declaration",
        runtime_verified: false,
        applicability: "configuration_review",
        advisory_id: PHP_SESSION_UPLOAD_PROGRESS_NOTICE.id,
        advisory_url: PHP_SESSION_UPLOAD_PROGRESS_NOTICE.url,
      },
      code_locations: [{ file: path, start_line: handler.line }],
    })
  }
  for (const [i, line] of content.split("\n").entries()) {
    if (findings.length >= 100) {
      recordCoverageIssue(issues, {
        scanner: "iac",
        status: "bounded",
        subject: path,
        reason: "PHP runtime configuration finding limit reached",
      })
      break
    }
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored, delimiter-separated fields on byte-bounded input
    const match = /^\s*(display_errors|allow_url_include)\s*=\s*(?:On|1|true)\s*(?:;.*)?$/i.exec(
      line
    )
    if (match)
      findings.push({
        id: `php-config-${path}-${i + 1}`,
        title: `PHP configuration declaration: ${match[1]} enabled`,
        severity: "low",
        timestamp: new Date().toISOString(),
        target: path,
        scannerSource: "iac",
        finding_class: "php_runtime_config",
        description:
          "Source configuration warning only; active pool, per-directory and deployment overrides are unknown.",
        remediation_steps:
          "Review the production configuration and disable this setting where appropriate. Independently confirm the effective configuration after deployment.",
        dependency_metadata: { evidence_scope: "source_declaration", runtime_verified: false },
        code_locations: [{ file: path, start_line: i + 1 }],
      })
  }
  return findings
}

function parseRuntimeDeclarations(
  path: string,
  content: string,
  kind: string | null,
  issues?: ScannerCoverageIssue[]
) {
  const findings: EngineVulnerability[] = []
  const declarations: Declaration[] = []
  const name = basename(path).toLowerCase()
  let phpPresent = isPhpRuntimeInput(name)
  const issue = (reason: string) =>
    recordCoverageIssue(issues, { scanner: "iac", status: "partial", subject: path, reason })
  if (Buffer.byteLength(content) > 512 * 1024) {
    recordCoverageIssue(issues, {
      scanner: "iac",
      status: "bounded",
      subject: path,
      reason: "PHP runtime input exceeds the 524288-byte scanner limit",
    })
    return { findings, declarations, phpPresent }
  }
  if (kind === "dockerfile") {
    for (const declaration of dockerImageDeclarations(content, issue))
      phpPresent =
        addImageDeclaration(declaration.image, declaration.line, true, declarations, issue) ||
        phpPresent
  } else if (kind === "compose") {
    try {
      const lineCounter = new LineCounter()
      const doc = parseDocument(content, { uniqueKeys: true, strict: true, lineCounter })
      if (doc.errors.length) throw new Error("invalid compose")
      const parsed: unknown = doc.toJS({ maxAliasCount: 0 })
      const shape = z
        .object({
          services: z.record(
            z.string().max(256),
            z.object({ image: z.string().max(256).optional() }).passthrough()
          ),
        })
        .passthrough()
        .safeParse(parsed)
      if (!shape.success) throw new Error("invalid compose services")
      for (const [serviceName, service] of Object.entries(shape.data.services).slice(0, 256)) {
        if (!service.image) continue
        const imageNode = doc.getIn(["services", serviceName, "image"], true)
        const line =
          isScalar(imageNode) && imageNode.range ? lineCounter.linePos(imageNode.range[0]).line : 1
        phpPresent =
          addImageDeclaration(service.image, line, false, declarations, issue, serviceName) ||
          phpPresent
      }
      if (Object.keys(shape.data.services).length > 256)
        issue("PHP runtime Compose inventory is bounded at 256 services")
    } catch {
      issue("PHP runtime Compose inventory is malformed or uses unsupported YAML aliases")
    }
  } else if (name === "project.toml" || name === ".php-version") {
    const parsed = parsePhpVersionFile(name, content, issue)
    phpPresent = parsed.phpPresent
    if (parsed.version)
      declarations.push({ version: parsed.version, scope: "source_declaration", line: 1 })
  } else if (name === "composer.json") {
    try {
      const schema = z
        .object({
          config: z
            .object({ platform: z.record(z.string(), z.unknown()).optional() })
            .passthrough()
            .optional(),
        })
        .passthrough()
      const parsed = schema.parse(parseIdentityJson(content))
      const version = parsed.config?.platform?.php
      if (typeof version === "string" && exactVersion.test(version))
        declarations.push({ version, scope: "source_declaration", line: 1 })
      else
        issue(
          "PHP runtime identity is unavailable: Composer requirements/platform constraints do not establish an exact runtime version"
        )
    } catch {
      issue("PHP runtime Composer inventory is malformed")
    }
  } else if (name === "php-runtime.json") {
    try {
      if (Buffer.byteLength(content) > 64 * 1024) throw new Error("bounded inventory")
      const parsed = inventorySchema.parse(parseIdentityJson(content))
      const imageVersion = parsed.image ? officialImagePattern.exec(parsed.image)?.[1] : undefined
      if (imageVersion && imageVersion !== parsed.version)
        issue(
          "PHP runtime inventory has conflicting version and official image identity; both require independent confirmation"
        )
      declarations.push({ ...parsed, scope: "user_reported", line: 1 })
      if (parsed.backports?.length)
        issue(
          "PHP runtime backport claims are user-reported and require independent vendor verification"
        )
    } catch {
      issue("PHP runtime inventory is malformed, unsupported or lacks an exact stable identity")
    }
  } else if (name === "php.ini") {
    findings.push(...phpConfigurationFindings(path, content, issues))
  }
  return { findings, declarations, phpPresent }
}

function appendWindowsBrotliFinding(
  path: string,
  declaration: Declaration,
  issues: ScannerCoverageIssue[] | undefined,
  findings: EngineVulnerability[],
  base: Pick<EngineVulnerability, "timestamp" | "target" | "scannerSource" | "code_locations">,
  metadata: NonNullable<EngineVulnerability["dependency_metadata"]>
): void {
  const serviceSuffix = declaration.composeService ? ` (service ${declaration.composeService})` : ""
  const identitySuffix = declaration.composeService
    ? `-${encodeURIComponent(declaration.composeService)}`
    : ""
  // Windows PHP package rebuilds retain the same interpreter version. Never
  // infer their Brotli build from a PHP version, extension list or image tag.
  const windowsBuilds: Record<string, string> = {
    "8.2.35": "8.2.35-1",
    "8.3.36": "8.3.36-1",
    "8.4.27": "8.4.27-1",
    "8.5.12": "8.5.12-1",
  }
  if (
    declaration.os === "windows" ||
    !declaration.os ||
    (declaration.scope === "user_reported" && declaration.windowsPackage)
  ) {
    const packageInfo = declaration.windowsPackage
    const rebuilt = windowsBuilds[declaration.version]
    const isOriginal =
      declaration.os === "windows" &&
      packageInfo?.origin === "php.net" &&
      rebuilt &&
      packageInfo.build === declaration.version &&
      !(declaration.image && officialImagePattern.test(declaration.image))
    recordCoverageIssue(issues, {
      scanner: "iac",
      status: "partial",
      scope: "php_windows_brotli",
      subject: path,
      reason:
        "Windows Brotli package and cURL configuration are user-reported or unknown; verify the serving package, bundled dependency and effective configuration independently",
    })
    if (isOriginal) {
      findings.push({
        ...base,
        id: `php-windows-brotli-CVE-2026-111497-${path}-${declaration.line}${identitySuffix}`,
        title: `Reported Windows PHP package ${declaration.version}: Brotli advisory${serviceSuffix}`,
        severity: "high",
        finding_class: "php_runtime_windows_brotli",
        cve: "CVE-2026-111497",
        description:
          "An original official PHP Windows package is reported. The bundled Brotli decoder may be reachable through cURL when automatic response decompression is enabled. Package identity, installed dependency, configuration and exploitability are unverified.",
        technical_analysis:
          "https://www.php.net/archive/2026.php#2026-10-26-1\nPHP's rebuilt Windows packages include Brotli 1.2.1 without changing the PHP runtime version. cURL automatic response decompression is disabled by default but applications or HTTP client libraries can enable it.",
        remediation_steps: `Obtain the official PHP Windows ${rebuilt} rebuilt package or a vendor-confirmed fixed Brotli package. Test compatibility, deploy and restart every affected instance, then independently verify the running package and effective cURL configuration. A source declaration or PHP version alone cannot prove remediation.`,
        dependency_metadata: {
          ...metadata,
          advisory_id: "CVE-2026-111497",
          advisory_url: "https://www.php.net/archive/2026.php#2026-10-26-1",
          applicability: "conditional_unverified",
          windows_package_origin: packageInfo.origin,
          windows_package_build: packageInfo.build,
        },
      })
    }
  }
}

function declaredRuntimeFindings(
  path: string,
  content: string,
  declaration: Declaration,
  issues?: ScannerCoverageIssue[]
): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const issue = (reason: string) =>
    recordCoverageIssue(issues, { scanner: "iac", status: "partial", subject: path, reason })
  const branch = branchOf(declaration.version)
  const supported = PHP_RUNTIME_CATALOG.supportedBranches.includes(branch)
  const metadata = {
    runtime_version: declaration.version,
    ...(declaration.composeService ? { compose_service: declaration.composeService } : {}),
    evidence_scope: declaration.scope,
    runtime_verified: false,
    catalog_version: PHP_RUNTIME_CATALOG.catalogVersion,
    sapi: declaration.sapi ?? "unknown",
    extensions: declaration.extensions?.join(",").slice(0, 2048) ?? "unknown",
    os: declaration.os ?? "unknown",
    image: declaration.image ?? "unknown",
    vendor_package: declaration.vendorPackage ?? "unknown",
    replicas: declaration.replicas ?? "unknown",
  }
  const base = {
    timestamp: new Date().toISOString(),
    target: path,
    scannerSource: "iac" as const,
    code_locations: [{ file: path, start_line: declaration.line }],
  }
  const serviceSuffix = declaration.composeService ? ` (service ${declaration.composeService})` : ""
  const identitySuffix = declaration.composeService
    ? `-${encodeURIComponent(declaration.composeService)}`
    : ""
  appendWindowsBrotliFinding(path, declaration, issues, findings, base, metadata)
  const [major, minor] = branch.split(".").map(Number)
  if (major! < 8 || (major === 8 && minor! < 2)) {
    findings.push({
      ...base,
      id: `php-eol-${path}-${declaration.line}${identitySuffix}`,
      title: `Declared PHP ${declaration.version} is end-of-life${serviceSuffix}`,
      severity: "high",
      finding_class: "php_runtime_eol",
      description: `This branch is unsupported in the catalog dated ${PHP_RUNTIME_CATALOG.asOf}; the source declaration is not installed-runtime verification.`,
      remediation_steps:
        "Upgrade to a supported PHP branch, test compatibility, rebuild, deploy and restart every replica; independently verify the running runtime.",
      dependency_metadata: metadata,
    })
  } else if (!supported)
    issue(
      "PHP runtime identity belongs to a branch outside the pinned catalog; advisory coverage is unknown"
    )
  for (const { advisory, range } of matchPhpRuntimeAdvisories(declaration.version)) {
    if (
      advisory.extension &&
      declaration.extensions &&
      !declaration.extensions.includes(advisory.extension)
    )
      continue
    if (advisory.sapi && declaration.sapi && declaration.sapi !== advisory.sapi) continue
    if (advisory.os && declaration.os && declaration.os !== advisory.os) continue
    const fixed =
      PHP_RUNTIME_CATALOG.advisories
        .flatMap((a) => a.ranges)
        .filter((r) => r.branch === branch)
        .map((r) => r.fixed)
        .sort((a, b) => patchOf(b) - patchOf(a))[0] ?? range.fixed
    // Full-file edits bind to an exact official mutable tag. Digests need verified registry data.
    const canEdit =
      !!declaration.mutableImage &&
      supported &&
      content.length <= 16000 &&
      content.split("\n").length <= 256
    const after = canEdit
      ? content
          .split("\n")
          .map((line, i) =>
            i + 1 === declaration.line
              ? line.replace(
                  declaration.mutableImage!,
                  declaration.mutableImage!.replace(`:${declaration.version}`, `:${fixed}`)
                )
              : line
          )
          .join("\n")
      : undefined
    findings.push({
      ...base,
      id: `php-runtime-${advisory.id}-${path}-${declaration.line}${identitySuffix}`,
      title: `Declared PHP ${declaration.version}: ${advisory.id}${serviceSuffix}`,
      severity: advisory.severity,
      finding_class: "php_runtime_cve",
      ...(advisory.id.startsWith("CVE-") ? { cve: advisory.id } : {}),
      description: `${advisory.summary}. Candidate based on ${declaration.scope}; runtime installation, exploitability and effective configuration are unverified.`,
      technical_analysis: `${advisory.url}\nBranch ${branch}: ${range.sourceRange}; fixed ${range.fixed}. Extension ${advisory.extension ?? "core/unspecified"}; SAPI ${advisory.sapi ?? "unspecified"}; OS ${advisory.os ?? "unspecified"}. Extension, SAPI, OS, configuration and vendor backports require independent confirmation.`,
      remediation_steps: `${supported ? `Update to PHP ${fixed} or a later patched release in this branch` : "Upgrade to a supported patched PHP branch after compatibility testing"}; rebuild, deploy and restart every replica. Confirm the running PHP version, SAPI, extensions, image digest and vendor backports independently. Source-only retesting cannot verify runtime remediation. ${advisory.url}`,
      dependency_metadata: {
        ...metadata,
        advisory_id: advisory.id,
        advisory_url: advisory.url,
        affected_range: range.sourceRange,
        fixed_version: range.fixed,
        applicability: "conditional_unverified",
        backport_claimed: declaration.backports?.includes(advisory.id) ?? false,
        required_extension: advisory.extension ?? "unspecified",
        required_sapi: advisory.sapi ?? "unspecified",
        required_os: advisory.os ?? "unspecified",
        kev: advisory.kev ?? false,
      },
      code_locations: [
        {
          file: path,
          start_line: declaration.line,
          ...(after ? { fix_before: content, fix_after: after } : {}),
        },
      ],
    })
  }
  return findings
}

/** Reuse parsed declarations from the existing IaC walk; no second traversal or file read. */
export function discoverPhpRuntimeInput(path: string, content: string, kind: string | null) {
  const issues: ScannerCoverageIssue[] = []
  return { ...parseRuntimeDeclarations(path, content, kind, issues), issues }
}

/** Passive declarations only. Neither PHP nor Composer is executed. */
export function inspectPhpRuntimeInput(
  path: string,
  content: string,
  kind: string | null,
  issues?: ScannerCoverageIssue[],
  discovered?: ReturnType<typeof discoverPhpRuntimeInput>
): { findings: EngineVulnerability[]; hasIdentity: boolean; phpPresent: boolean } {
  const parsed = discovered ?? discoverPhpRuntimeInput(path, content, kind)
  for (const issue of parsed.issues) recordCoverageIssue(issues, issue)
  for (const declaration of parsed.declarations) {
    if (parsed.findings.length >= 100) {
      recordCoverageIssue(issues, {
        scanner: "iac",
        status: "bounded",
        subject: path,
        reason: "PHP runtime finding limit reached",
      })
      break
    }
    const candidates = declaredRuntimeFindings(path, content, declaration, issues)
    if (candidates.length > 100 - parsed.findings.length)
      recordCoverageIssue(issues, {
        scanner: "iac",
        status: "bounded",
        subject: path,
        reason: "PHP runtime finding limit reached",
      })
    parsed.findings.push(...candidates.slice(0, 100 - parsed.findings.length))
  }
  return {
    findings: parsed.findings,
    hasIdentity: parsed.declarations.length > 0,
    phpPresent: parsed.phpPresent,
  }
}

/** Only already-collected response headers; no additional requests or exploit probes. */
export function phpRuntimeBannerFindings(
  headers: Record<string, string>,
  url: string
): EngineVulnerability[] {
  const value = Object.entries(headers)
    .filter(([key]) => ["server", "x-powered-by"].includes(key.toLowerCase()))
    .map(([, v]) => v.slice(0, 512))
    .join(" ")
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded header values and delimiter-separated PHP version fields
  const match = /\bPHP\/(\d+\.\d+(?:\.\d+)?(?:[a-zA-Z0-9.+~-]{0,32})?)/.exec(value)
  if (!match) return []
  return [
    {
      id: `php-runtime-banner-${url}`,
      title: "Public PHP version banner (unverified lead)",
      severity: "info",
      timestamp: new Date().toISOString(),
      target: url,
      scannerSource: "url",
      finding_class: "php_runtime_banner",
      description:
        "The public response reports a PHP version. Proxy headers can be stale or spoofed and do not establish runtime identity or vulnerability.",
      dependency_metadata: {
        runtime_version: match[1]!,
        evidence_scope: "public_banner",
        runtime_verified: false,
      },
      remediation_steps:
        "Confirm runtime identity, vendor patches and all serving replicas through authorized runtime inventory before advisory matching. Disable unnecessary version disclosure.",
    },
  ]
}
