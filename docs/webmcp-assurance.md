# WebMCP Assurance

WebMCP Assurance is a LyraShield AI feature that helps builders discover, review, and harden [WebMCP](https://webmcp.devpost.com/resources) tools registered in browser applications. The shared deterministic analyzer runs in the public no-login lab, full-repository scans, and CLI. The GitHub Action mirrors a guarded high-confidence subset for fast PR gating.

## What it checks

WebMCP is the browser-native extension of the Model Context Protocol. A page can register tools that a model or agent can call. Those tools can read UI state, prepare scans, or trigger durable actions. WebMCP Assurance checks the resulting tool surface against ten controls.

## Control catalog

| ID        | Title                                                      | Severity | Strategy      |
| --------- | ---------------------------------------------------------- | -------- | ------------- |
| WEBMCP-01 | Annotation/behavior mismatch                               | HIGH     | deterministic |
| WEBMCP-02 | External content without untrusted content hint            | MEDIUM   | deterministic |
| WEBMCP-03 | Unsafe or dynamic cross-origin exposure                    | HIGH     | deterministic |
| WEBMCP-04 | Explicitly unsafe permissions or disabled origin isolation | HIGH     | deterministic |
| WEBMCP-05 | Durable mutation without visible confirmation              | CRITICAL | deterministic |
| WEBMCP-06 | Sensitive or unbounded input/output contract               | MEDIUM   | deterministic |
| WEBMCP-07 | Network operation does not forward cancellation            | MEDIUM   | deterministic |
| WEBMCP-08 | Registration lacks lifecycle cleanup                       | MEDIUM   | deterministic |
| WEBMCP-09 | Weak schema or missing runtime validation                  | HIGH     | deterministic |
| WEBMCP-10 | Duplicate, overlapping, or misleading tool contract        | MEDIUM   | deterministic |

Each control produces one of four evidence states: `DETECTED`, `NO_FINDING`, `INCONCLUSIVE`, or `NOT_ASSESSED`. No `INCONCLUSIVE` or `NOT_ASSESSED` result is treated as a clean pass.

## Architecture

The feature has four layers:

1. **Shared analyzer** (`packages/security/src/webmcp/`): type definitions, AST/parse5 source discovery, canonical serialization, deterministic hashing, the policy engine, and a safe `TextEdit` rewrite planner. Heavy parsers are exposed only through the `./webmcp/discover` and `./webmcp/rewrite` exports; the default `./webmcp` export is browser-safe.
2. **Worker scan** (`apps/worker`): the existing AI App Security scanner runs WebMCP discovery and evaluation over the same bounded source collection, then converts the signals into the existing normalized finding model.
3. **CLI and Action** (`packages/cli`): `lyrashield check-diff` and `lyrashield gate` analyze changed files, emit SARIF, and can fail builds on `CRITICAL`/`HIGH` WebMCP findings.
4. **Browser surfaces**: the public **Security Lab** and the authenticated dashboard tool registry. The public lab runs the heavy parser in a lazy Web Worker so source never leaves the device. Dashboard tools are page-scoped, read or prepare-only, and require explicit human confirmation before any durable mutation.

## Public Security Lab

- Open `/tools/webmcp-security-checker` (linked from `/webmcp`).
- Paste or select local source files.
- The lab preloads an unsafe example.
- Analysis runs in the browser; no source is uploaded.
- Output: tool inventory, findings, coverage, a deterministic rewrite preview, and JSON/Markdown/SARIF export.
- Apply never commits or deploys; it only updates the local preview, and the user must copy the result out.

## Dashboard WebMCP tools

The authenticated app registers at most one page-scoped tool at a time:

- `review_launch_readiness` — read-only summary of launch blockers.
- `review_findings` — read-only explanation of a selected finding.
- `prepare_security_scan` — UI-only form preparation; the existing Start button still performs the scan.

All dashboard tools:

- Capture workspace context from server props, not tool arguments.
- Sanitize and bound any untrusted content from finding text.
- Unregister stale handlers when the workspace or page changes.
- Abort in-flight calls on navigation or context change.
- Produce a visible activity receipt for every invocation.

## Security and privacy

- Source text, schemas, and findings are never sent to a model, analytics, or the server.
- Only aggregate, non-identifying events (feature availability, tool name, duration bucket, status) may be recorded by existing analytics.
- Tool descriptions, finding snippets, and source text are treated as untrusted input and are not used as instructions.
- Public payloads never include target URLs, workspace IDs, API keys, raw IPs, or evidence storage URIs.

## CLI/Action usage

```bash
# Local advisory check of changed files
lyrashield check-diff --base origin/main --head HEAD --sarif webmcp.sarif

# Blocking gate
lyrashield gate --fail-on HIGH
```

The GitHub Action uses the same rule IDs and severities for its documented high-confidence subset. The CLI and repository scanner run the complete shared analyzer.

## Limitations

- WebMCP is an experimental browser API. Support and shape may change.
- Detection is deterministic static analysis; it is not verification.
- `INCONCLUSIVE` means coverage is incomplete and must not be treated as safe.
- The v1 rewrite engine automatically rewrites only statically located wildcard `exposedTo` declarations to same-origin scope. Other findings remain unresolved guidance rather than unsafe generated code.
- The dedicated parser Worker is about 1.03 MiB compressed in the current production build and loads only when analysis starts; the interactive page code is about 8.5 KiB compressed.
- The public lab requires a browser that supports `document.modelContext` for the native tool-registration demo; the core source analysis still works without it.

## Pinned evaluation references

- Official WebMCP resources: `https://webmcp.devpost.com/resources`
- WebMCP type package: `webmcp-types@0.1.5` (MIT)
- Detector version: `webmcp-assurance/1`
- Inventory version: `webmcp-inventory/1`
