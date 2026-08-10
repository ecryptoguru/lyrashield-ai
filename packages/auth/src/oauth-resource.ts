export function resourcesMatch(resources: string[] | undefined, expected: string): boolean {
  return !resources || resources.every((resource) => resource === expected)
}
