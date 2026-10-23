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
    supportedBranches: z.array(z.string()),
    advisories: z.array(advisorySchema).max(100),
  })
  .strict()

export const PHP_RUNTIME_CATALOG = PHP_RUNTIME_CATALOG_SCHEMA.parse(data)
