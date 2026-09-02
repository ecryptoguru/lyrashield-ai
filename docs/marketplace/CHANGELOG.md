# Changelog

## 0.1.18 distribution corrections

- Pin the published MCP 0.2.2 package and preserve credential-store OAuth refresh.
- Align client artifact versions, Kiro discovery instructions and Kilo configuration.
- Use canonical tool names and retain human approval for fix proposals.

## 0.1.18

- Sanitized marketplace validation failures so detected credentials are never echoed into CI logs.
- Regenerated the deterministic public marketplace boundary from the current product source.

## 0.1.17

- Removed the Zed extension's `process:exec` capability after it was found unnecessary; the
  extension now uses only Zed's `npm:install` capability to run the npm-installed MCP server.
  The Zed Rust extension starts from the local OAuth credential store; the settings API key is
  an explicit CI/non-OAuth fallback.
- Made the generated Cursor and Kiro shims OAuth-first, so neither writes an API-key variable into
  a plugin manifest. The Zed extension now starts from the same local OAuth credential store; its
  settings API key is an explicit CI/non-OAuth fallback and uses only Zed's `npm:install` capability.
- Corrected the bundled skill's pre-PR and weekly-monitor defaults to `QUICK`, matching the
  current bounded-release contract, and bumped the Codebuff read-only review agent to `0.1.2`.
- Flattened the portable Agent Plugin into the marketplace root, so conformant clients discover
  its `plugin.json`, OAuth-first `mcp.json`, and `skills/` together.
- Removed the mandatory API-key header from the Claude Code MCP config so fresh connections reach
  the hosted OAuth flow, and restored the complete Apache-2.0 license plus the OpenClaw MIT-0 file.
- Bundled LyraShield workspace dependencies into the published MCP package so a clean `npx`
  installation does not try to resolve private workspace packages from npm.
- Clarified that repository auto-detection is local-stdio-only; hosted MCP clients now require an
  explicit repository or target identifier instead of inspecting the server checkout.
- Republished Codebuff `lyrashield-review` as `0.1.1` with its read-only LyraShield MCP
  server declaration; the prior public `0.1.0` listing had an empty MCP server map.
- Added a narrow MIT-0 grant for the OpenClaw skill directory so the community ClawHub listing can
  publish its `v1.0.1` metadata correction without changing the Apache-2.0 license of the broader
  marketplace bundle.

## 0.1.12

- Declared Zed's required Node process capability in the extension manifest.

## 0.1.11

- Corrected API-key settings links in the Cline and Zed installation guides.

## 0.1.10

- Declared the bundled skill in the OpenAI/Codex manifest using the current plugin format.

## 0.1.9

- Added Claude Code-native root `skills/` and `.mcp.json` artifacts.
- Made Claude Code OAuth-first by registering only the hosted remote MCP server.
- Aligned public artifact metadata with the public marketplace repository.

## 0.1.8

- Reconciled exported marketplace artifacts with current source.
- Corrected Codebuff publisher slug to `lyrashield`.
- Refreshed OAuth/legal link metadata and reviewer pack.

## 0.1.0

- Initial Apache-2.0 marketplace release boundary.
- OAuth-first hosted MCP connection with read-only default and approval-gated writes.
- Gemini CLI, Kiro, Cline, Kilo, OpenClaw, Zed, and Codebuff artifacts.
- Sanitized reviewer workflows and marketplace submission fixtures.
