/** Documentation and test examples do not establish a deployed PHP project. */
export function isExcludedPhpPath(path: string): boolean {
  return (
    /(?:^|\/)(?:docs?|documentation|__tests__|tests?|fixtures?|testdata|examples?|e2e|mocks?)(?:\/|$)/i.test(
      path
    ) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(path) ||
    /(?:^|\/)[^/]*(?:Test|Spec)\.php$/.test(path)
  )
}

export function isPhpServiceBoundary(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    [
      "package.json",
      "composer.json",
      "php-runtime.json",
      "php.ini",
      "project.toml",
      ".php-version",
      "dockerfile",
      "containerfile",
      "compose.yaml",
      "compose.yml",
    ].includes(lower) ||
    lower.startsWith("dockerfile.") ||
    (lower.startsWith("docker-compose") && (lower.endsWith(".yaml") || lower.endsWith(".yml")))
  )
}

export function nearestProjectBoundary(
  path: string,
  boundaries: Iterable<string>
): string | undefined {
  return [...boundaries]
    .filter(
      (directory) => directory === "." || path === directory || path.startsWith(directory + "/")
    )
    .sort((a, b) => b.length - a.length)[0]
}
