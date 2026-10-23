// security-scan-skip-file: bounded lexer for untrusted PHP source; never executes it
export interface PhpToken {
  text: string
  kind: "word" | "variable" | "string" | "symbol"
  line: number
}

const TOKEN_LIMIT = 40_000

/** Small lexical subset, not a PHP parser. Unsupported syntax stays incomplete. */
export function tokenizePhp(source: string, issues: string[]): PhpToken[] {
  const tokens: PhpToken[] = []
  let offset = 0
  let line = 1
  let inPhp = false
  while (offset < source.length) {
    if (tokens.length >= TOKEN_LIMIT) {
      issues.push(`PHP source token limit (${TOKEN_LIMIT}) reached`)
      break
    }
    const rest = source.slice(offset)
    let text = ""
    let kind: PhpToken["kind"] = "symbol"
    if (!inPhp) {
      const tag = /<\?(?:php\b|=)/i.exec(rest)
      text = tag ? rest.slice(0, tag.index + tag[0].length) : rest
      inPhp = Boolean(tag)
    } else if (rest.startsWith("?>")) {
      text = "?>"
      // PHP closes the preceding statement even when a template omits its semicolon.
      tokens.push({ text: ";", kind: "symbol", line })
      inPhp = false
    } else if (/^\s/.test(rest)) {
      text = /^\s+/.exec(rest)![0]
    } else if (/^(?:\/\/|#)/.test(rest)) {
      text = rest.split("\n", 1)[0]!
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2)
      text = end < 0 ? rest : rest.slice(0, end + 2)
      if (end < 0) issues.push("Unsupported unterminated PHP comment")
    } else if (rest.startsWith("<<<") || rest.startsWith("`")) {
      issues.push("Unsupported PHP heredoc/nowdoc or backtick execution syntax")
      break
    } else {
      if (rest[0] === "'" || rest[0] === '"') {
        let end = 1
        while (end < rest.length) {
          if (rest[end] === "\\") end += 2
          else if (rest[end++] === rest[0]) break
        }
        text = rest.slice(0, end)
        kind = "string"
        if (text.length < 2 || text.at(-1) !== text[0]) {
          issues.push("Unsupported unterminated PHP string")
        }
      } else {
        const match = /^(\$[a-zA-Z_][\w]*|[a-zA-Z_][\w]*|\?->|->|::|=>|\.=|[^\s])/.exec(rest)
        text = match![0]
        kind = text.startsWith("$") ? "variable" : /^\w/.test(text) ? "word" : "symbol"
      }
      tokens.push({ text, kind, line })
    }
    line += text.split("\n").length - 1
    offset += text.length
  }
  return tokens
}

export function closingToken(tokens: PhpToken[], start: number): number {
  const close = new Map([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]).get(tokens[start]?.text ?? "")
  if (!close) return -1
  let depth = 0
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i]?.text === tokens[start]?.text) depth++
    if (tokens[i]?.text === close && --depth === 0) return i
  }
  return -1
}

export function splitPhpArguments(tokens: PhpToken[]): PhpToken[][] {
  const args: PhpToken[][] = [[]]
  let depth = 0
  for (const token of tokens) {
    if (token.text === "," && depth === 0) args.push([])
    else args[args.length - 1]!.push(token)
    if (["(", "[", "{"].includes(token.text)) depth++
    if ([")", "]", "}"].includes(token.text)) depth--
  }
  return args
}
