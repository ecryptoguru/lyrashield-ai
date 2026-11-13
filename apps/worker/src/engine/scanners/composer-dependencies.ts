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

interface ComposerJsonSource {
  keys: string[]
  numbers: Map<string, string>
}
const COMPOSER_JSON_SOURCE = Symbol("composerJsonSource")
type ComposerManifest = Record<string, unknown> & {
  [COMPOSER_JSON_SOURCE]?: WeakMap<object, ComposerJsonSource>
}

export function parseComposerManifest(content: string): Record<string, unknown> {
  const manifest: unknown = JSON.parse(content)
  if (!object(manifest)) throw new Error("Composer manifest must be an object")
  // JSON.parse reorders integer keys and loses integer/float token identity.
  // Keep only that source metadata so PHP's JSON encoding remains reproducible.
  const sources = new WeakMap<object, ComposerJsonSource>()
  let position = 0
  function whitespace(): void {
    while (/\s/.test(content[position] ?? "x")) position++
  }
  function stringToken(): string {
    const start = position++
    while (position < content.length) {
      const character = content[position++]
      if (character === '"') break
      if (character === "\\") position++
    }
    return content.slice(start, position)
  }
  function visit(value: unknown, depth = 0): string | undefined {
    if (depth > 128) throw new Error("Composer JSON nesting exceeds scanner limit")
    whitespace()
    if (content[position] === "{" || content[position] === "[") {
      const array = content[position++] === "["
      const end = array ? "]" : "}"
      if (!value || typeof value !== "object") throw new Error("Ambiguous Composer JSON")
      const source: ComposerJsonSource = { keys: [], numbers: new Map() }
      sources.set(value, source)
      whitespace()
      const seenKeys = new Set<string>()
      while (content[position] !== end) {
        const key = array ? String(source.keys.length) : (JSON.parse(stringToken()) as string)
        if (seenKeys.has(key)) throw new Error("Duplicate Composer JSON key")
        seenKeys.add(key)
        if (!array) {
          whitespace()
          position++
        }
        source.keys.push(key)
        const number = visit((value as Record<string, unknown>)[key], depth + 1)
        if (number !== undefined) source.numbers.set(key, number)
        whitespace()
        if (content[position] !== ",") break
        position++
        whitespace()
      }
      position++
      return undefined
    }
    if (content[position] === '"') {
      stringToken()
      return undefined
    }
    const start = position
    while (position < content.length && !/[\s,}\]]/.test(content[position]!)) position++
    return typeof value === "number" ? content.slice(start, position) : undefined
  }
  visit(manifest)
  Object.defineProperty(manifest, COMPOSER_JSON_SOURCE, { value: sources })
  return manifest
}

function phpNumber(value: number, source?: string): string {
  if (!Number.isFinite(value)) throw new Error("Non-finite Composer JSON number")
  const token =
    source !== undefined && JSON.parse(source) === value ? source : JSON.stringify(value)
  if (/^-?\d+$/.test(token)) {
    const integer = BigInt(token)
    if (integer >= -9223372036854775808n && integer <= 9223372036854775807n)
      return integer.toString()
  }
  if (Object.is(value, -0)) return "-0"
  const absolute = Math.abs(value)
  if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e17)) {
    const [coefficient, exponent] = value.toExponential().split("e")
    return `${coefficient!.includes(".") ? coefficient : `${coefficient}.0`}e${exponent}`
  }
  return String(value)
}

function phpJson(
  value: unknown,
  sources?: WeakMap<object, ComposerJsonSource>,
  numberSource?: string
): string {
  if (typeof value === "number") return phpNumber(value, numberSource)
  if (!value || typeof value !== "object") return JSON.stringify(value)
  const source = sources?.get(value)
  const availableKeys = new Set(Object.keys(value))
  const originalKeys = new Set(source?.keys)
  const keys = [
    ...(source?.keys.filter((key) => availableKeys.has(key)) ?? []),
    ...[...availableKeys].filter((key) => !originalKeys.has(key)),
  ]
  const entries = keys.map(
    (key) =>
      [
        key,
        phpJson((value as Record<string, unknown>)[key], sources, source?.numbers.get(key)),
      ] as const
  )
  if (Array.isArray(value) || keys.every((key, index) => key === String(index))) {
    return `[${entries.map(([, encoded]) => encoded).join(",")}]`
  }
  return `{${entries.map(([key, encoded]) => `${JSON.stringify(key)}:${encoded}`).join(",")}}`
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

/**
 * Composer Locker::getContentHash: dependency-relevant root keys, sorted once.
 * Use parseComposerManifest() to retain original numeric token/key information.
 */
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
  const encoded = phpJson(sorted, (manifest as ComposerManifest)[COMPOSER_JSON_SOURCE])
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
