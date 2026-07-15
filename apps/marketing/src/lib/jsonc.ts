export function parseJsonc<T>(input: string): T {
  const withoutLineComments = input.replace(/^\s*\/\/.*$/gm, "")
  const withoutTrailingCommas = withoutLineComments.replace(/,\s*([}\]])/g, "$1")

  return JSON.parse(withoutTrailingCommas) as T
}
