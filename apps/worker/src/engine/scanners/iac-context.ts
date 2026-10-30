// security-scan-skip-file: passive contextual detection, never execution
/* eslint-disable security/detect-unsafe-regex */

/** Track the effective USER of the final image, including inheritance from earlier stages. */
export function dockerContext(lines: string[]): {
  unpinned: Set<number>
  rootLine?: number
  implicitRoot: boolean
} {
  const stages = new Map<string, { rootLine?: number; implicitRoot: boolean }>()
  const unpinned = new Set<number>()
  let stage: string | undefined
  let stageIndex = -1
  let rootLine: number | undefined
  let implicitRoot = true
  for (const [index, raw] of lines.entries()) {
    const comment = raw.indexOf("#")
    const line = (comment > 0 && /\s/.test(raw[comment - 1]!) ? raw.slice(0, comment) : raw).trim()
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line)
    if (from) {
      if (stageIndex >= 0) stages.set(String(stageIndex), { rootLine, implicitRoot })
      if (stage) stages.set(stage, { rootLine, implicitRoot })
      stageIndex++
      const image = from[1]!
      const alias = image.toLowerCase()
      const inherited = stages.get(alias)
      rootLine = inherited?.rootLine
      implicitRoot = inherited?.implicitRoot ?? true
      stage = from[2]?.toLowerCase()
      if (
        image !== "scratch" &&
        !stages.has(alias) &&
        !image.includes("$") &&
        !image.includes("@") &&
        (!image.slice(image.lastIndexOf("/") + 1).includes(":") || image.endsWith(":latest"))
      )
        unpinned.add(index)
    }
    const user = /^USER\s+(\S+)/i.exec(line)?.[1]
    if (user) {
      rootLine = /^(?:root|0)(?::|$)/i.test(user) ? index : undefined
      implicitRoot = false
    }
  }
  return { unpinned, rootLine, implicitRoot }
}

/** Environment only: service labels and secret-file references are not credential literals. */
export function composeEnvironmentLines(lines: string[]): Set<number> {
  const result = new Set<number>()
  let indentation: number | undefined
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = /^\s*/.exec(line)![0].length
    if (indentation !== undefined && indent <= indentation) indentation = undefined
    if (/^\s*environment\s*:\s*(?:#.*)?$/.test(line)) indentation = indent
    else if (indentation !== undefined) result.add(index)
  }
  return result
}

interface Direction {
  value?: string
  standalone?: boolean
}

/** Brace/string/comment aware block context; a standalone rule's type may follow its CIDRs. */
export function terraformIngressLines(content: string): Set<number> {
  const clean = content.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
  const stack: Array<Direction | undefined> = []
  const candidates: Array<{ index: number; direction?: Direction }> = []
  for (const [index, line] of clean.split("\n").entries()) {
    const code = line.replace(/"(?:\\.|[^"\\])*"|#[^\n]*|\/\/[^\n]*/g, (token) =>
      token.startsWith('"') ? token : ""
    )
    const structure = code.replace(/"(?:\\.|[^"\\])*"/g, (value) => " ".repeat(value.length))
    const inspect = (segment: string) => {
      const direction = stack.at(-1)
      const type = /\btype\s*=\s*"(ingress|egress)"/.exec(segment)?.[1]
      if (type && direction?.standalone) direction.value = type
      if (/\bcidr_blocks\s*=/.test(segment)) candidates.push({ index, direction })
    }
    let start = 0
    for (const match of structure.matchAll(/[{}]/g)) {
      const segment = code.slice(start, match.index)
      inspect(segment)
      if (match[0] === "{") {
        const header = segment.trim()
        let direction = stack.at(-1)
        if (/^(?:ingress|egress)$/.test(header)) direction = { value: header }
        else if (/^resource\s+"aws_vpc_security_group_ingress_rule"/.test(header))
          direction = { value: "ingress" }
        else if (/^resource\s+"[^"\n]*(?:security_group_rule|firewall_rule)[^"\n]*"/.test(header))
          direction = { standalone: true }
        stack.push(direction)
      } else stack.pop()
      start = match.index + 1
    }
    inspect(code.slice(start))
  }
  return new Set(
    candidates.filter(({ direction }) => direction?.value === "ingress").map(({ index }) => index)
  )
}
