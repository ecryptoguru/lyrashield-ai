# Marketplace reviewer pack

**State: PREPARATION.** The case set and package metadata are drafted for Agent Plugin
`0.1.31`. They have not been uploaded, run in a publisher portal, or accepted by a directory.
The latest published `@lyrashield/agent-plugin` is `0.1.30`; the matching source, package
and marketplace release remains a separate release decision.

## OpenAI Codex and ChatGPT plugin directory

The canonical package is the portable root at `packages/agent-plugin/plugin/`. It declares one
remote server in `mcp.json` using the Agent Plugins 1.0 `streamable-http` transport and carries
the five shared workflow skills plus the backward-compatible `lyrashield` skill. OpenAI's
onboarding path is `./skills/get-started/SKILL.md`. The separate `.codex-plugin/` layout remains
the Codex compatibility package; its presentation fields belong at the Codex manifest root.

The portable manifest currently prepares these known listing URLs:

| OpenAI field     | Prepared URL or value              |
| ---------------- | ---------------------------------- |
| Website          | `https://lyrashieldai.com`         |
| Support          | `https://lyrashieldai.com/support` |
| Privacy policy   | `https://lyrashieldai.com/privacy` |
| Terms of service | `https://lyrashieldai.com/terms`   |
| Onboarding skill | `./skills/get-started/SKILL.md`    |

The primary logo and composer icon use `./assets/lyrashield-400.png`, a square 400 × 400 PNG.
No `screenshots` are declared. Screenshots are optional in the current OpenAI MCP package
reference; if we add them, capture only real product behavior: a named client/version/OS showing
LyraShield plugin and skill discovery after reload, and the public setup/authentication guidance
the user follows. Redact user/workspace identifiers and credentials. The logo is not a product
screenshot.

The `extensions.com.openai.interface.category` field is omitted until the publisher selects a
valid category in the dashboard. `review.demo_recording_url` is also omitted: the required,
accessible walkthrough has not been recorded. Do not fill either field with a guess or placeholder.
The five positive and three negative cases in [workflows.json](./workflows.json) use the current
MCP tool names, but none have been run with a reviewer account. One positive case starts a scan
and another requests a retest; run these only against a synthetic staging workspace after its
non-billable status and authorization are confirmed. There is no production scan authorization in
this pack.

The two supplemental checks in `workflows.json` cover conflicting idempotency retries and a
revoked connection. They are separate from OpenAI's required three negative cases and are marked
`NOT_RUN`; they are test expectations, not runtime receipts.

Before any OpenAI submission:

1. Inspect the existing plugin in the private dashboard and preserve its assigned identity and
   existing country availability. A private dashboard readback has not been performed.
2. Use the same verified developer identity for the app and accessible public URLs. Confirm that
   the identity is entitled to submit; do not infer it from the public product name.
3. Confirm the package version and all manifest paths in the exact release ZIP, upload it, and
   resolve the automated package and skill findings. The included icon and onboarding skill must
   be in that ZIP.
4. Complete domain verification and a current successful scan of the production MCP server in
   the publisher portal. Neither has been run as part of this preparation.
5. Supply a dedicated reviewer account and immediately usable synthetic workspace through the
   secure portal fields, never in this public package. Run all eight cases using that account and
   confirm scan/retest execution cannot charge a production account.
6. Add an accessible video URL demonstrating the reviewed use cases and tools, and add release
   notes for the exact uploaded version. The recording and private reviewer credentials are
   currently absent.
7. Review the dashboard's selected category, identity, country targeting and imported metadata;
   submit only after the package, runtime and reviewer materials pass their separate checks.

## Claude Code directory

The portable skills and hosted MCP configuration can be submitted as one plugin bundle, but the
current Anthropic directory flow also calls for the hosted MCP server to be submitted separately
as an MCP connector so the two listings can be paired. A public repository and the organization
that should own the listing are required. The private developer portal has not been inspected;
the state of any historical Console submission is unknown. The OpenAI reviewer cases are not a
substitute for Anthropic's own plugin and connector checks.

Before updating the existing listing, inspect `claude.ai/directory/manage` and identify whether
an older Console submission must be withdrawn or moved. Confirm the paid-plan and organization
role needed to submit, publish the matching public package version, then test and read back the
plugin and connector independently. Do not claim either is submitted or listed from this pack.

## Cursor Marketplace

Cursor accepts the portable Agent Plugins format as well as Cursor-specific plugins. Test the
released portable package from `~/.cursor/plugins/local`, reload Cursor, and confirm both skill
and MCP discovery in Customize before an application. Record client version and OS. Enterprise
local plugin imports can be disabled, and an installed marketplace copy can take precedence over
a local copy, so record those conditions when relevant.

The public publisher portal has not been inspected and no application readback is available.
After local acceptance, submit the public Git repository through Cursor's publisher flow, provide
the current source and support/privacy information, and record the publisher's response. Cursor's
official docs do not make a screenshot a substitute for the discovery test; no runtime screenshot
or receipt is claimed here.

## Kiro Powers

The prepared Kiro Power uses the Agent Plugins format. Its README contains current privacy and
support links, and `plugin.json` includes the package identity, version, keywords and SPDX license.
Kiro's publisher requirements additionally call for a complete, tested Power, a public GitHub
repository, and acceptance of publisher terms. The current local candidate is unpublished; the
private Power dashboard and any existing submission have not been checked. Current client
discovery and runtime acceptance also remain unverified.

Use the public repository root containing `plugin.json` for a publisher submission after the
coordinated release. Do not submit the nested folder URL as an assumed subdirectory import. Before
updating the existing application, check the Kiro dashboard, verify IDE/Web/CLI version gates,
accept the current publisher terms through the authorized publisher account, and retain an actual
Power discovery plus authenticated read-only-call receipt.

## Shared safe-test policy

Use a disposable reviewer account containing synthetic projects and findings only. Keep
credentials in the publisher's secure review form, not in this repository, ZIP, video, screenshots
or logs. Preserve `DETECTED`, `INCONCLUSIVE`, `INSUFFICIENT_EVIDENCE`, and pending-retest states
exactly. A passing package check or a directory listing is not evidence that the client loaded the
plugin or that a scan established security.

## Current official references

- [OpenAI upload and submission requirements](https://developers.openai.com/plugins/deploy/submission)
- [Anthropic directory publishing](https://claude.com/docs/directory/publish)
- [Cursor plugins and local testing](https://cursor.com/docs/plugins)
- [Cursor publisher terms](https://cursor.com/marketplace-publisher-terms)
- [Kiro Power submission requirements](https://kiro.dev/powers/submit/)
