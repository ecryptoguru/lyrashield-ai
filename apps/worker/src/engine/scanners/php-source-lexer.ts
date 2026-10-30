// security-scan-skip-file: bounded lexer for untrusted PHP source; never executes it
export interface PhpToken {
  text: string
  kind: "word" | "variable" | "string" | "symbol"
  line: number
  position: number
  closing?: number
}

const TOKEN_LIMIT = 40_000

/** Small lexical subset, not a PHP parser. Unsupported syntax stays incomplete. */
export function* tokenizePhpChunks(source: string, issues: string[]): Generator<void, PhpToken[]> {
  const tokens: PhpToken[] = []
  let offset = 0
  let line = 1
  let inPhp = false
  let chunkStart = 0
  let chunkTokens = 0
  const delimiters: PhpToken[] = []
  const push = (text: string, kind: PhpToken["kind"]) => {
    const token: PhpToken = { text, kind, line, position: tokens.length }
    tokens.push(token)
    if (kind !== "symbol") return
    if (["(", "[", "{"].includes(text)) delimiters.push(token)
    else if ([")", "]", "}"].includes(text)) {
      const opening = delimiters.pop()
      if (opening && "([{".indexOf(opening.text) === ")]}".indexOf(text))
        opening.closing = token.position
    }
  }
  while (offset < source.length) {
    if (tokens.length >= TOKEN_LIMIT) {
      issues.push(`PHP source token limit (${TOKEN_LIMIT}) reached`)
      break
    }
    if (offset - chunkStart >= 16_384 || tokens.length - chunkTokens >= 256) {
      yield
      chunkStart = offset
      chunkTokens = tokens.length
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
      push(";", "symbol")
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
      push(text, kind)
    }
    line += text.split("\n").length - 1
    offset += text.length
  }
  return tokens
}

export function closingToken(tokens: PhpToken[], start: number): number {
  const closing = tokens[start]?.closing
  if (closing === undefined) return -1
  // Slices preserve source positions; flattened argument lists can omit comma tokens.
  let low = start + 1
  let high = tokens.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const position = tokens[middle]!.position
    if (position === closing) return middle
    if (position < closing) low = middle + 1
    else high = middle - 1
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
