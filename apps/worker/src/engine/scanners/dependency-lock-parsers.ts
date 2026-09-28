/* eslint-disable security/detect-unsafe-regex */
import type { OsvQueryPackage } from "@lyrashield/db"

function packageNameFromNodeModulesPath(path: string): string | undefined {
  const marker = "node_modules/"
  const index = path.lastIndexOf(marker)
  if (index < 0) return undefined
  const rest = path.slice(index + marker.length)
  if (!rest || rest.includes("/node_modules/")) return undefined
  const parts = rest.split("/")
  return rest.startsWith("@")
    ? parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : undefined
    : parts[0]
}

export function parsePackageLock(content: string, filePath: string): OsvQueryPackage[] {
  try {
    const lock = JSON.parse(content) as { packages?: Record<string, { version?: unknown }> }
    return Object.entries(lock.packages ?? []).flatMap(([path, value]) => {
      const name = packageNameFromNodeModulesPath(path)
      return name && typeof value.version === "string" && value.version
        ? [{ name, version: value.version, ecosystem: "npm" as const, filePath }]
        : []
    })
  } catch {
    return []
  }
}

export function parsePnpmLock(content: string, filePath: string): OsvQueryPackage[] {
  const packages: OsvQueryPackage[] = []
  for (const match of content.matchAll(
    /^\s{2}['"]?((?:@[^/\s]+\/)?[^@'"\s]+)@([0-9][^:'"\s(]*)(?:\([^)]*\))?['"]?:\s*$/gm
  )) {
    if (match[1] && match[2]) {
      packages.push({ name: match[1], version: match[2], ecosystem: "npm", filePath })
    }
  }
  return packages
}

export function parseYarnLock(content: string, filePath: string): OsvQueryPackage[] {
  const packages: OsvQueryPackage[] = []
  const lines = content.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const header = /^['"]?((?:@[^/\s]+\/)?[^@,'"\s]+)@[^:]+/.exec(lines[index] ?? "")
    if (!header?.[1]) continue
    const version = /^\s+version\s+['"]([^'"]+)['"]\s*$/.exec(lines[index + 1] ?? "")?.[1]
    if (version) packages.push({ name: header[1], version, ecosystem: "npm", filePath })
  }
  return packages
}
