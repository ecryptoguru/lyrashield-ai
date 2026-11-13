/** One contract for scanner admission, coverage explanations and public copy.
 * Resolution support describes an input format, never universal language coverage.
 */
export const DEPENDENCY_RESOLUTION_CAPABILITIES = [
  {
    ecosystem: "npm",
    inputs: ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"],
    method: "lockfile",
    limitation: "Exact resolved registry versions only",
  },
  {
    ecosystem: "PyPI",
    inputs: ["requirements.txt", "requirements.lock"],
    method: "pinned-requirements",
    limitation: "Exact pinned requirements only",
  },
  {
    ecosystem: "Packagist",
    inputs: ["composer.lock"],
    method: "lockfile",
    limitation: "Composer lockfile consistency and source qualification apply",
  },
  {
    ecosystem: "crates.io",
    inputs: ["Cargo.lock"],
    method: "lockfile",
    limitation:
      "Cargo v3/v4 public registry releases; git, path and private sources remain incomplete",
  },
  {
    ecosystem: "RubyGems",
    inputs: ["Gemfile.lock"],
    method: "lockfile",
    limitation:
      "Public RubyGems versions with recorded platforms; git, path and private sources remain incomplete",
  },
  {
    ecosystem: "Go",
    inputs: ["go.mod", "go.work"],
    method: "isolated-module-graph",
    limitation:
      "Pinned local toolchain and public metadata required; go.sum alone is insufficient; local replacements remain incomplete",
  },
  {
    ecosystem: "Maven",
    inputs: ["pom.xml", "build.gradle", "build.gradle.kts"],
    method: "unsupported",
    limitation: "Exact Maven/Gradle resolution is not supported",
  },
] as const
