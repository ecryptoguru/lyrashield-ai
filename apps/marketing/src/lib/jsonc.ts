export function parseJsonc<T>(input: string): T {
  const withoutLineComments = input.replace(/^\s*\/\/.*$/gm, "")
  const withoutTrailingCommas = withoutLineComments.replace(/,\s*([}\]])/g, "$1")

  try {
    return JSON.parse(withoutTrailingCommas) as T
  } catch (err) {
    throw new SyntaxError(`Invalid JSONC: ${err instanceof Error ? err.message : String(err)}`)
  }
}
