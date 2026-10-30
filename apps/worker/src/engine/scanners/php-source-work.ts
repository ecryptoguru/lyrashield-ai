import type { PhpFlow } from "./php-source-flow"

export class PhpWorkLimit extends Error {
  constructor(public readonly scope: "statement" | "file") {
    super(`PHP ${scope} token visit limit (${scope === "statement" ? 100_000 : 1_000_000}) reached`)
  }
}

/** Per-analysis state. Never shared across files, requests, or local-variable environments. */
export class PhpWork {
  private statementVisits = 0
  private fileVisits = 0
  readonly expressions = new Map<string, PhpFlow>()
  nestingLimits = 0

  beginStatement(): void {
    this.statementVisits = 0
    this.expressions.clear()
  }

  visit(count = 1): void {
    if (this.fileVisits + count > 1_000_000) throw new PhpWorkLimit("file")
    if (this.statementVisits + count > 100_000) throw new PhpWorkLimit("statement")
    this.fileVisits += count
    this.statementVisits += count
  }
}
