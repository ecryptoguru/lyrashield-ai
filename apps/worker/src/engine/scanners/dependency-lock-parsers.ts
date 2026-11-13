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
  for (const line of content.split("\n")) {
    const entry = parsePnpmEntry(line)
    if (entry) packages.push({ ...entry, ecosystem: "npm", filePath })
  }
  return packages
}

function parsePnpmEntry(line: string): { name: string; version: string } | undefined {
  if (!isLockfileWhitespace(line[0]) || !isLockfileWhitespace(line[1])) return undefined
  if (isLockfileWhitespace(line[2])) return undefined

  let selector = line.slice(2).trimEnd()
  if (!selector.endsWith(":")) return undefined
  selector = selector.slice(0, -1)

  const quote = selector[0]
  if (quote === "'" || quote === '"') {
    if (selector.at(-1) !== quote) return undefined
    selector = selector.slice(1, -1)
  } else if (selector.endsWith("'") || selector.endsWith('"')) {
    // Do not accept an unmatched trailing quote as part of a package/version.
    return undefined
  }

  const scoped = selector.startsWith("@")
  const slash = scoped ? selector.indexOf("/") : -1
  if (scoped && (slash <= 1 || slash === selector.length - 1)) {
    return undefined
  }
  const separator = selector.indexOf("@", scoped ? slash + 1 : 0)
  if (separator <= 0 || separator === selector.length - 1) return undefined

  const name = selector.slice(0, separator)
  let version = selector.slice(separator + 1)
  const peerSuffix = version.indexOf("(")
  if (peerSuffix >= 0) {
    if (!version.endsWith(")")) return undefined
    version = version.slice(0, peerSuffix)
  }
  const firstVersionCharacter = version[0] ?? ""
  if (!firstVersionCharacter || firstVersionCharacter < "0" || firstVersionCharacter > "9") {
    return undefined
  }
  for (const character of version) {
    if (
      character === ":" ||
      character === "'" ||
      character === '"' ||
      isLockfileWhitespace(character)
    ) {
      return undefined
    }
  }
  return { name, version }
}

export function parseYarnLock(content: string, filePath: string): OsvQueryPackage[] {
  const packages: OsvQueryPackage[] = []
  const lines = content.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const name = parseYarnHeaderName(lines[index] ?? "")
    if (!name) continue
    const version = parseYarnVersion(lines[index + 1] ?? "")
    if (version) packages.push({ name, version, ecosystem: "npm", filePath })
  }
  return packages
}

function parseYarnHeaderName(line: string): string | undefined {
  let cursor = 0
  const quote = line[0]
  if (quote === "'" || quote === '"') cursor++

  let nameEnd: number
  if (line[cursor] === "@") {
    const slash = line.indexOf("/", cursor + 1)
    if (slash <= cursor + 1) return undefined
    const packageStart = slash + 1
    nameEnd = findYarnNameEnd(line, packageStart)
    if (nameEnd <= packageStart) return undefined
  } else {
    nameEnd = findYarnNameEnd(line, cursor)
  }
  if (nameEnd <= cursor || line[nameEnd] !== "@") return undefined

  const colon = line.lastIndexOf(":")
  if (colon <= nameEnd + 1) return undefined

  const headerQuote = line[0]
  if ((headerQuote === "'" || headerQuote === '"') && line[colon - 1] !== headerQuote) {
    return undefined
  }
  return line.slice(cursor, nameEnd)
}

function findYarnNameEnd(line: string, start: number): number {
  let cursor = start
  while (cursor < line.length) {
    const character = line[cursor]
    if (
      character === "@" ||
      character === "," ||
      character === "'" ||
      character === '"' ||
      isLockfileWhitespace(character)
    ) {
      break
    }
    cursor++
  }
  return cursor
}

function isLockfileWhitespace(character: string | undefined): boolean {
  return character !== undefined && character.trim().length === 0
}

function parseYarnVersion(line: string): string | undefined {
  let cursor = 0
  while (isLockfileWhitespace(line[cursor])) cursor++
  if (cursor === 0 || !line.startsWith("version", cursor)) return undefined
  cursor += "version".length
  if (!isLockfileWhitespace(line[cursor])) return undefined
  while (isLockfileWhitespace(line[cursor])) cursor++

  const quote = line[cursor]
  if (quote !== "'" && quote !== '"') return undefined
  const end = line.indexOf(quote, cursor + 1)
  if (end <= cursor + 1) return undefined
  for (let index = cursor + 1; index < end; index++) {
    if (line[index] === "'" || line[index] === '"') return undefined
  }
  for (let index = end + 1; index < line.length; index++) {
    if (!isLockfileWhitespace(line[index])) return undefined
  }
  return line.slice(cursor + 1, end)
}
