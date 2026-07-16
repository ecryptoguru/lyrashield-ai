function withoutCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ")
}

export function markdownWordCount(markdown: string): number {
  const prose = withoutCode(markdown)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_>{}|]/g, " ")

  // Keep this release-critical count byte-for-byte aligned with the validator.
  // eslint-disable-next-line security/detect-unsafe-regex
  return prose.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0
}

export function readingMinutes(markdown: string): number {
  return Math.max(1, Math.round(markdownWordCount(markdown) / 200))
}
