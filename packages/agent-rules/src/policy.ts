import type { Policy } from "./types.js"

export const LYRASHIELD_POLICY: Policy = {
  version: "1.0.0",
  title: "LyraShield Security Policy for AI Coding Agents",
  honestyClause: "A clean check result does not guarantee the absence of all vulnerabilities.",
  sections: [
    {
      id: "pre-pr",
      title: "Pre-PR check",
      instructions: [
        "Run check_diff on the staged changes to identify security issues introduced by this work item.",
        "Review any findings before committing.",
        "If findings are reported, address them or document why each is acceptable.",
      ],
    },
    {
      id: "post-fix",
      title: "Post-fix verification",
      instructions: [
        "After applying a fix for a security finding, run verify_fix with the finding ID.",
        "Include the verification receipt in the PR description.",
      ],
    },
    {
      id: "scope-limits",
      title: "Scope limits",
      instructions: [
        "Only run security checks against targets that are owned by this workspace and explicitly listed as authorized targets in the LyraShield settings.",
        "Do not run checks on files or URLs you do not have permission to scan.",
        "Do not run scans against third-party URLs or repositories without explicit authorization.",
      ],
    },
    {
      id: "honesty",
      title: "Honesty clause",
      instructions: [
        "A clean check result does not guarantee the absence of all vulnerabilities.",
        "A passing check is not a guarantee of zero vulnerabilities.",
      ],
    },
  ],
}
