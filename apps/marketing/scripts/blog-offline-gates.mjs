/**
 * Offline gates for problems the blog validators keep missing because our
 * tooling is more permissive than the build.
 *
 * Both checks here are deterministic and need no network, so they can run in CI
 * on every commit alongside the other blog validators.
 */

/**
 * External URLs that are known-dead and keep coming back.
 *
 * The copy is regenerated from an upstream source that still holds these links,
 * so the same eight were reintroduced three times across releases 1 and 2.
 * `blog:check-links` catches them but cannot be a merge gate: it calls ~50
 * third-party URLs and would make merges depend on their uptime (a transient
 * code.visualstudio.com timeout appeared during a release-2 run).
 *
 * Add an entry when check-links finds a 404 whose replacement is known; remove
 * one if a URL ever comes back.
 */
export const DEAD_URLS = Object.freeze({
  "https://claude.com/docs/claude-code/mcp": "https://docs.claude.com/en/docs/claude-code/mcp",
  "https://docs.github.com/en/actions/security-for-github-actions/using-artifacts":
    "https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file-to-github",
  "https://docs.github.com/en/actions/security-hardening-your-deployments":
    "https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments",
  "https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file":
    "https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file-to-github",
  "https://docs.github.com/en/copilot/customizing-copilot/using-prompt-files":
    "https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/your-first-prompt-file",
  "https://modelcontextprotocol.io/specification/2025-06-18/specification":
    "https://modelcontextprotocol.io/specification/2025-06-18",
  "https://nextjs.org/docs/app/guides/security": "https://nextjs.org/docs/app/guides/data-security",
  "https://www.jetbrains.com/help/idea/using-mcp-server.html":
    "https://www.jetbrains.com/help/ai-assistant/mcp.html",
  "https://www.first.org/epss/user-guide": "https://www.first.org/epss/",

  // Round 2: found by a live check-links sweep of main after release 2, which
  // had never been run against tranches 2-5 because check-links is not a gate.
  "https://cwe.mitre.org/top25/archive/cwe/top25.html": "https://cwe.mitre.org/top25/",
  "https://nodejs.org/en/docs/guides/": "https://nodejs.org/learn",
  // The dead link also had the wrong entry number: Broken Object Level
  // Authorization is API1 in the 2023 edition, not API2.
  "https://owasp.org/API-Security/editions/2023/en/0xa2-broken-object-level-authorization/":
    "https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/",
  "https://www.nist.gov/itl/ssdm/software-supply-chain-security":
    "https://www.nist.gov/itl/executive-order-14028-improving-nations-cybersecurity/software-supply-chain-security-guidance",
  "https://owasp.org/www-project-top-10-for-llm-applications/":
    "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
  "https://www.anthropic.com/engineering/desktop":
    "https://www.anthropic.com/engineering/desktop-extensions",
  // Returns 405 rather than 404, so check-links flags it but a casual browser
  // visit can look fine.
  "https://docs.cline.bot/mcp": "https://docs.cline.bot/mcp/mcp-overview",

  // Aider ships no native MCP support, so there is no equivalent page. The post
  // that linked here was reframed around the CLI and GitHub Action instead, with
  // native MCP called out as roadmap, so the link is simply gone rather than
  // repointed. Mapping it to the docs index would imply an MCP page exists.
  "https://aider.chat/docs/mcp/mcp.html": "https://aider.chat/docs/",
})

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Returns the known-dead URLs present in `text`, longest match first.
 *
 * A dead URL followed by another path segment is a different URL and is left
 * alone, which is what keeps the two overlapping GitHub SARIF paths from both
 * firing on the longer one.
 */
export function findDeadUrls(text) {
  const found = []
  for (const dead of Object.keys(DEAD_URLS).sort((a, b) => b.length - a.length)) {
    if (found.some((hit) => hit.startsWith(dead))) continue
    if (new RegExp(`${escapeRegExp(dead)}(?![\\w/-])`).test(text)) found.push(dead)
  }
  return found
}

/**
 * Frontmatter scalars that YAML will not read the way the author intended.
 *
 * Astro parses frontmatter with js-yaml; `parseArticle` is a hand-rolled line
 * reader and is more permissive. An unquoted value containing ": " is a nested
 * mapping to YAML, which fails `astro check` with "bad indentation of a mapping
 * entry" and a file:line the blog validators never see. Three descriptions hit
 * exactly this during release 2 and cost a full CI round.
 */
export function findUnquotedColonScalars(frontmatter) {
  const offenders = []
  for (const [index, line] of frontmatter.split("\n").entries()) {
    const match = /^([A-Za-z][\w-]*):[ \t]+(?!["'|>])(.*)$/.exec(line)
    if (match && /: /.test(match[2])) offenders.push({ key: match[1], line: index + 1 })
  }
  return offenders
}
