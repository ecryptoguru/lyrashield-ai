import { z } from "zod"
import data from "./php-runtime-advisories.json"

export const exactVersion = /^(?:0|[1-9]\d?)\.(?:0|[1-9]\d?)\.(?:0|[1-9]\d{0,3})$/
export const versionSchema = z.string().regex(exactVersion)
export const branchOf = (version: string) => version.split(".").slice(0, 2).join(".")
export const patchOf = (version: string) => Number(version.split(".")[2])
const rangeSchema = z
  .object({
    branch: z.string().regex(/^\d+\.\d+$/),
    introduced: versionSchema,
    fixed: versionSchema,
    sourceRange: z.string().max(64),
  })
  .strict()
  .refine(
    (r) =>
      branchOf(r.introduced) === r.branch &&
      branchOf(r.fixed) === r.branch &&
      patchOf(r.introduced) < patchOf(r.fixed) &&
      /^<\s*\d+\.\d+\.\d+$/.test(r.sourceRange) &&
      r.sourceRange.replace(/^<\s*/, "") === r.fixed,
    "ambiguous PHP advisory branch range"
  )
const advisorySchema = z
  .object({
    id: z.string().max(64),
    ghsa: z.string().max(64).optional(),
    published: z.string().max(10),
    summary: z.string().max(300),
    severity: z.enum(["low", "medium", "high", "critical"]),
    url: z.string().url().max(300),
    ranges: z
      .array(rangeSchema)
      .min(1)
      .max(8)
      .refine(
        (ranges) => new Set(ranges.map((r) => r.branch)).size === ranges.length,
        "duplicate advisory branch"
      ),
    extension: z.string().max(64).optional(),
    sapi: z.enum(["fpm", "cgi"]).optional(),
    os: z.literal("windows").optional(),
    kev: z.boolean().optional(),
  })
  .strict()
export const PHP_RUNTIME_CATALOG_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    catalogVersion: z.string(),
    asOf: z.string(),
    lifecycleSource: z.string().url(),
    endOfLifeBeforeBranch: z.string().regex(/^\d+\.\d+$/),
    supportedBranches: z.array(z.string()),
    advisories: z.array(advisorySchema).max(100),
  })
  .strict()

export const PHP_RUNTIME_CATALOG = PHP_RUNTIME_CATALOG_SCHEMA.parse(data)

/** Exact branch matching shared by passive worker analysis and the public checker. */
export function matchPhpRuntimeAdvisories(version: string) {
  if (version.trim() !== version || !exactVersion.test(version)) return []
  const branch = branchOf(version)
  return PHP_RUNTIME_CATALOG.advisories.flatMap((advisory) => {
    const range = advisory.ranges.find((entry) => entry.branch === branch)
    return range &&
      patchOf(version) >= patchOf(range.introduced) &&
      patchOf(version) < patchOf(range.fixed)
      ? [{ advisory, range }]
      : []
  })
}

/** The original October 21 advisories only. This does not assess installed runtimes. */
export function assessPhpRuntimeVersion(input: string): {
  status: "affected" | "fixed" | "unsupported" | "invalid"
  version: string | null
  branch: string | null
  fixedVersion: string | null
  advisoryIds: string[]
} {
  if (input.length > 32 || input.trim() !== input || !exactVersion.test(input))
    return { status: "invalid", version: null, branch: null, fixedVersion: null, advisoryIds: [] }
  const branch = branchOf(input)
  const original = PHP_RUNTIME_CATALOG.advisories.filter((advisory) =>
    ["CVE-2026-109618", "CVE-2026-109619"].includes(advisory.id)
  )
  const ranges = original.flatMap((advisory) =>
    advisory.ranges.filter((range) => range.branch === branch)
  )
  if (!PHP_RUNTIME_CATALOG.supportedBranches.includes(branch) || ranges.length !== original.length)
    return { status: "unsupported", version: input, branch, fixedVersion: null, advisoryIds: [] }
  const fixedVersion = ranges
    .map((range) => range.fixed)
    .sort((a, b) => patchOf(b) - patchOf(a))[0]!
  const advisoryIds = matchPhpRuntimeAdvisories(input)
    .filter(({ advisory }) => original.some((entry) => entry.id === advisory.id))
    .map(({ advisory }) => advisory.id)
    .sort()
  return {
    status: advisoryIds.length ? "affected" : "fixed",
    version: input,
    branch,
    fixedVersion,
    advisoryIds,
  }
}

/** No version bounds or released fix were published in this informational notice. */
export const PHP_SESSION_UPLOAD_PROGRESS_NOTICE = {
  id: "CVE-2026-115560",
  published: "2026-10-23",
  url: "https://www.php.net/archive/2026.php",
  description:
    "Review session upload progress: the notice requires upload progress enabled, session.serialize_handler configured as php_binary or php_serialize and application code switching it to php using ini_set() before session_start(). Active configuration and application behavior require independent confirmation.",
  remediation:
    "Disable session.upload_progress.enabled in startup configuration (php.ini, an FPM pool or server configuration that applies before request parsing), then restart every worker. Do not rely on ini_set() or FPM .user.ini. Independently confirm effective configuration; the notice has no published fixed-version boundary.",
} as const
