/** Parse bounded provider JSON without accepting ambiguous duplicate member names. */
export function parseStrictJson(body: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body)
  const value: unknown = JSON.parse(text)
  const stack: Array<Set<string> | null> = []
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      const start = index
      index += 1
      while (index < text.length) {
        if (text[index] === "\\") index += 2
        else if (text[index] === '"') break
        else index += 1
      }
      let next = index + 1
      while (next < text.length && /[ \t\r\n]/.test(text[next]!)) next += 1
      const keys = stack.at(-1)
      if (text[next] === ":" && keys instanceof Set) {
        const key: unknown = JSON.parse(text.slice(start, index + 1))
        if (typeof key !== "string" || keys.has(key)) throw new Error("duplicate JSON member")
        keys.add(key)
      }
    } else if (character === "{" || character === "[") {
      stack.push(character === "{" ? new Set() : null)
      if (stack.length > 64) throw new Error("JSON nesting limit exceeded")
    } else if (character === "}" || character === "]") {
      stack.pop()
    }
  }
  return value
}
