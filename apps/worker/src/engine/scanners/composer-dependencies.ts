/* eslint-disable security/detect-unsafe-regex */
import { createHash } from "node:crypto"
import type { OsvQueryPackage } from "@lyrashield/db"

type Unresolved = Array<{ ecosystem: string; name: string; reason: string }>
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/
const EXACT_VERSION =
  /^v?(\d+(?:\.\d+){0,3}(?:-(?:alpha|beta|RC|patch|p)[.-]?\d*)?(?:\+[A-Za-z0-9.-]+)?)$/i

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function parseComposerManifest(content: string): Record<string, unknown> {
  const manifest: unknown = JSON.parse(content)
  if (!object(manifest)) throw new Error("Composer manifest must be an object")
  return manifest
}

export function composerRequirements(
  manifest: Record<string, unknown>,
  filePath: string,
  unresolved: Unresolved
): string[] {
  const names: string[] = []
  for (const section of ["require", "require-dev"]) {
    const requirements = manifest[section]
    if (requirements === undefined) continue
    if (!object(requirements)) {
      unresolved.push({
        ecosystem: "Packagist",
        name: filePath,
        reason: `invalid ${section} requirements`,
      })
      continue
    }
    for (const [name, constraint] of Object.entries(requirements)) {
      // PHP, ext-*, lib-* and composer-* describe the platform, not Packagist releases.
      if (!name.includes("/")) continue
      if (!PACKAGE_NAME.test(name) || typeof constraint !== "string" || !constraint.trim()) {
        unresolved.push({ ecosystem: "Packagist", name, reason: "invalid Composer requirement" })
      } else {
        names.push(name)
      }
    }
  }
  return names
}

/** Composer Locker::getContentHash: dependency-relevant root keys, sorted once. */
export function composerContentHash(manifest: Record<string, unknown>): string {
  const keys = [
    "name",
    "version",
    "require",
    "require-dev",
    "conflict",
    "replace",
    "provide",
    "minimum-stability",
    "prefer-stable",
    "repositories",
    "extra",
  ]
  const relevant = Object.fromEntries(
    keys.filter((key) => key in manifest).map((key) => [key, manifest[key]])
  )
  const config = manifest.config
  if (object(config) && config.platform !== undefined && config.platform !== null) {
    relevant.config = { platform: config.platform }
  }
  const sorted = Object.fromEntries(
    Object.entries(relevant).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  )
  // PHP json_encode(..., 0) escapes slashes and non-ASCII UTF-16 code units.
  const encoded = JSON.stringify(sorted, (_key, value: unknown) => {
    // Composer decodes associative arrays: empty objects and contiguous numeric
    // object keys are encoded as PHP lists when it hashes the parsed manifest.
    if (object(value)) {
      const entries = Object.entries(value)
      if (entries.every(([key], index) => key === String(index))) {
        return entries.map(([, entry]) => entry)
      }
    }
    return value
  })
    .replace(/\//g, "\\/")
    .replace(
      /[\u0080-\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
    )
  return createHash("md5").update(encoded).digest("hex")
}

export function parseComposerLock(
  content: string,
  filePath: string,
  unresolved: Unresolved
): { packages: OsvQueryPackage[]; contentHash: unknown } {
  const lock: unknown = JSON.parse(content)
  if (!object(lock)) throw new Error("Composer lockfile must be an object")
  const packages: OsvQueryPackage[] = []
  for (const section of ["packages", "packages-dev"]) {
    const records = lock[section]
    if (records === undefined && section === "packages-dev") continue
    if (!Array.isArray(records)) {
      unresolved.push({
        ecosystem: "Packagist",
        name: filePath,
        reason: `invalid ${section} lockfile section`,
      })
      continue
    }
    for (const record of records) {
      const name = object(record) && typeof record.name === "string" ? record.name : filePath
      const version = object(record) && typeof record.version === "string" ? record.version : ""
      const exact = version.length <= 128 ? EXACT_VERSION.exec(version) : null
      if (!PACKAGE_NAME.test(name) || !exact?.[1] || exact[0] !== version) {
        unresolved.push({
          ecosystem: "Packagist",
          name,
          reason: "package is not a valid exact Composer release",
        })
        continue
      }
      packages.push({ name, version: exact[1], ecosystem: "Packagist", filePath })
    }
  }
  if (packages.length === 0)
    unresolved.push({
      ecosystem: "Packagist",
      name: filePath,
      reason: "no exact resolved dependencies could be parsed",
    })
  return { packages, contentHash: lock["content-hash"] }
}
