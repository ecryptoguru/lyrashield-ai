export type MyraMarkdownBlock =
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; items: string[] }
  | { type: "code"; text: string }

export function parseMyraMarkdownBlocks(markdown: string): MyraMarkdownBlock[] {
  const blocks: MyraMarkdownBlock[] = []
  let inFence = false
  let codeLines: string[] = []
  let listItems: string[] = []
  let para: string[] = []

  const flushPara = () => {
    if (!para.length) return
    blocks.push({ type: "paragraph", lines: para })
    para = []
  }
  const flushList = () => {
    if (!listItems.length) return
    blocks.push({ type: "list", items: listItems })
    listItems = []
  }
  const flushCode = () => {
    if (!codeLines.length) return
    blocks.push({ type: "code", text: codeLines.join("\n") })
    codeLines = []
  }

  for (const raw of markdown.split("\n")) {
    const trimmed = raw.trim()
    if (trimmed.startsWith("```")) {
      if (inFence) flushCode()
      inFence = !inFence
      flushPara()
      flushList()
      continue
    }
    if (inFence) {
      codeLines.push(raw)
      continue
    }
    if (!trimmed) {
      flushPara()
      flushList()
      continue
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/) ?? trimmed.match(/^\d{1,2}[.)]\s+(.*)$/)
    if (bullet && bullet[1] !== undefined) {
      flushPara()
      listItems.push(bullet[1])
      continue
    }
    flushList()
    para.push(trimmed)
  }
  flushPara()
  flushList()
  if (inFence) flushCode()
  return blocks
}
