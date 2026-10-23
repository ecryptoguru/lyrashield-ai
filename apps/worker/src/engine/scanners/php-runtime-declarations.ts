import * as TOML from "@iarna/toml"
import { z } from "zod"
import { exactVersion } from "./php-runtime-catalog"

const phpBuildpacks = new Set(["paketo-buildpacks/php", "paketo-buildpacks/php-dist"])
const environment = z
  .array(z.object({ name: z.string().max(128), value: z.string().max(256).optional() }).strict())
  .max(256)
const groups = z
  .array(
    z
      .object({
        id: z.string().max(256).optional(),
        uri: z.string().max(512).optional(),
        script: z.unknown().optional(),
      })
      .passthrough()
  )
  .max(256)
const build = z.object({ env: environment.optional(), buildpacks: groups.optional() }).passthrough()
const descriptor = z
  .object({
    _: z
      .object({ "schema-version": z.string().max(16).optional() })
      .passthrough()
      .optional(),
    io: z
      .object({
        buildpacks: z
          .object({
            "schema-version": z.string().optional(),
            build: build.optional(),
            group: groups.optional(),
            pre: z.unknown().optional(),
            post: z.unknown().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    build: build.optional(),
  })
  .passthrough()

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Only configuration tables declare runtime inputs; project metadata is free-form. */
function phpMarkers(document: unknown): { present: boolean; versions: number } {
  const root = record(document)
  const legacy = record(root.build)
  const current = record(record(root.io).buildpacks)
  const currentBuild = record(current.build)
  let present = false
  let versions = 0
  const count = (item: Record<string, unknown>, environmentEntry = false) => {
    for (const name of ["BP_PHP_VERSION", "PHP_VERSION"]) {
      if (Object.hasOwn(item, name) || (environmentEntry && item.name === name)) {
        present = true
        versions++
      }
    }
  }
  for (const configuration of [root, legacy, current, currentBuild]) {
    count(configuration)
    for (const name of ["env", "environment"]) {
      const env = configuration[name]
      if (Array.isArray(env)) {
        if (env.length > 256) throw new Error("bounded descriptor environment")
        for (const entry of env) count(record(entry), true)
      } else count(record(env), true)
    }
  }
  for (const value of [
    current.group,
    legacy.buildpacks,
    currentBuild.buildpacks,
    record(current.pre).group,
    record(current.post).group,
  ]) {
    if (!Array.isArray(value)) continue
    if (value.length > 256) throw new Error("bounded descriptor group")
    for (const entry of value) {
      const group = record(entry)
      if (
        [group.id, group.uri].some(
          (id) =>
            typeof id === "string" && /(?:^|\/)paketo-buildpacks\/php(?:-dist)?(?:[:@]|$)/.test(id)
        )
      )
        present = true
    }
  }
  return { present, versions }
}

export function parsePhpVersionFile(
  name: string,
  content: string,
  issue: (reason: string) => void
): { phpPresent: boolean; version?: string } {
  let phpPresent = name === ".php-version"
  try {
    if (Buffer.byteLength(content) > 64 * 1024) throw new Error("descriptor exceeds 64 KiB")
    if (name === ".php-version") {
      const version = content.replace(/\r?\n$/, "")
      if (!exactVersion.test(version) || version.includes("\n") || version.trim() !== version)
        throw new Error("ambiguous version file")
      issue(
        "PHP version-file source declaration is unverified; environment and container overrides require independent confirmation"
      )
      return { phpPresent: true, version }
    }
    const raw = TOML.parse(content)
    const markers = phpMarkers(raw)
    phpPresent = markers.present
    if (!phpPresent) return { phpPresent: false }
    const parsed = descriptor.parse(raw)
    const current = parsed.io?.buildpacks
    if (current && parsed.build) throw new Error("mixed descriptor layouts")
    if (
      parsed["schema-version"] !== undefined ||
      (current
        ? parsed._?.["schema-version"] !== "0.2" ||
          (current["schema-version"] !== undefined && current["schema-version"] !== "0.2")
        : parsed._ !== undefined)
    )
      throw new Error("unsupported descriptor schema")
    const configuration = current ?? parsed.build
    if (
      (configuration?.include !== undefined && configuration.exclude !== undefined) ||
      current?.build?.buildpacks !== undefined
    )
      throw new Error("unsupported descriptor selectors")
    const env = current?.build?.env ?? parsed.build?.env ?? []
    const versions = env.filter((entry) => entry.name === "BP_PHP_VERSION")
    const selectedGroups = current?.group ?? parsed.build?.buildpacks ?? []
    if (
      current?.pre !== undefined ||
      current?.post !== undefined ||
      selectedGroups.some(
        (group) =>
          !group.id ||
          !phpBuildpacks.has(group.id) ||
          group.uri !== undefined ||
          group.script !== undefined
      )
    )
      throw new Error("unsupported buildpack override")
    const version = versions[0]?.value
    if (
      markers.versions !== 1 ||
      versions.length !== 1 ||
      typeof version !== "string" ||
      !exactVersion.test(version)
    )
      throw new Error("missing, conflicting or inexact buildpack PHP version")
    issue(
      "PHP buildpack source declaration is unverified; build-time environment, builder and launch overrides require independent confirmation"
    )
    return { phpPresent: true, version }
  } catch {
    issue(
      "PHP runtime version-file/buildpack descriptor is malformed, bounded, unsupported or lacks one unambiguous exact stable declaration"
    )
    return { phpPresent }
  }
}
