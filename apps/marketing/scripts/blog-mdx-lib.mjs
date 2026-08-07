/**
 * Detects the MDX authoring hazards that only surface at prerender time.
 *
 * MDX evaluates `{...}` in prose as a JavaScript expression and `<Word ...>` as
 * JSX. Both compile cleanly and then fail while rendering the page, so the blog
 * content validators cannot see them and the build error arrives with no file
 * name attached. The recurring cause in this repo is an inline code span that is
 * opened and never closed: every later backtick on the line re-pairs, and text
 * that was meant to be code (`${VAR}`, `{Authorization: "..."}`) escapes into a
 * live expression.
 *
 * Deliberately dependency-free, matching the other blog validators. CI installs
 * with --frozen-lockfile, so a real MDX parser would mean a lockfile change for
 * a check that only needs to reason about fences, code spans and delimiters.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** Strips fenced code blocks, preserving line numbering. */
export function stripFencedBlocks(body) {
  const lines = body.split("\n")
  let fence = null
  return lines.map((line) => {
    const match = FENCE.exec(line)
    if (fence === null && match) {
      fence = match[1][0].repeat(3)
      return ""
    }
    if (fence !== null) {
      if (match && match[1].startsWith(fence)) fence = null
      return ""
    }
    return line
  })
}

/**
 * Splits text into code-span and prose regions using CommonMark backtick-run
 * pairing: a run of N backticks closes only against another run of exactly N.
 */
export function partitionCodeSpans(text) {
  const runs = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "`") continue
    if (index > 0 && text[index - 1] === "\\") continue
    let end = index
    while (end < text.length && text[end] === "`") end += 1
    runs.push({ start: index, length: end - index })
    index = end - 1
  }

  const spans = []
  const unterminated = []
  const open = []
  for (const run of runs) {
    const match = open.findIndex((candidate) => candidate.length === run.length)
    if (match === -1) {
      open.push(run)
      continue
    }
    spans.push({ start: open[match].start, end: run.start + run.length })
    open.splice(0, match + 1)
  }
  for (const run of open) unterminated.push(run.start)

  return { spans, unterminated }
}

const inSpans = (spans, offset) => spans.some((s) => offset >= s.start && offset < s.end)

/** Returns [line, column] for a character offset in the joined body. */
function locate(lines, offset) {
  let seen = 0
  for (let index = 0; index < lines.length; index += 1) {
    const next = seen + lines[index].length + 1
    if (offset < next) return [index + 1, offset - seen + 1]
    seen = next
  }
  return [lines.length, 1]
}

export function findMdxHazards(body) {
  const lines = stripFencedBlocks(body)
  const text = lines.join("\n")
  const { spans, unterminated } = partitionCodeSpans(text)
  const hazards = []

  for (const offset of unterminated) {
    const [line, column] = locate(lines, offset)
    hazards.push({ kind: "unterminated-code-span", line, column })
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char !== "{" && char !== "<") continue
    if (index > 0 && text[index - 1] === "\\") continue
    if (inSpans(spans, index)) continue
    // `<` is only JSX when a tag name or closing slash follows it.
    if (char === "<" && !/[A-Za-z/]/.test(text[index + 1] ?? "")) continue
    const [line, column] = locate(lines, index)
    hazards.push({
      kind: char === "{" ? "mdx-expression" : "jsx-element",
      line,
      column,
      snippet: text.slice(index, index + 48).split("\n")[0],
    })
  }

  return hazards.sort((a, b) => a.line - b.line || a.column - b.column)
}
