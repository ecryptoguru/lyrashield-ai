# WebMCP runtime checks (opt-in)

`scripts/webmcp-runtime-check.mjs` exercises customer-controlled WebMCP
fixture pages inside an ephemeral browser profile and emits a
`lyrashield-webmcp-runtime/1` receipt describing what actually happened.

It is the runtime complement to the static analyzer
(`packages/security/src/webmcp/`): static detections describe source shape;
runtime observations describe what one browser did against one fixture set.
The two are reported separately — a runtime check never relabels a static
finding, and neither can substitute for the other.

## Run

```sh
node scripts/webmcp-runtime-check.mjs \
  --fixture-dir e2e/webmcp-runtime/fixtures \
  --json /tmp/webmcp-receipt.json --markdown /tmp/webmcp-receipt.md
```

Options:

- `--fixture-dir <dir>` — serve only this directory on an ephemeral
  `127.0.0.1` port (the sole permitted loopback origin) and check every
  top-level `*.html`/`*.htm`.
- `--target <url>` — repeatable. `/x.html` selects a fixture page; an
  absolute `https?://` URL adds a declared, non-loopback target.
- `--allow-origin <origin>` — repeatable. Extra origins pages may request
  (ws/wss allowed). Loopback entries are rejected outright.
- `--active-tool <name>` + `--active-input '<json>'` + `--active-abort-ms N` —
  repeatable; run ONLY the named tools with the supplied synthetic input.
  Opt-in per tool: `readOnlyHint` alone never proves a tool safe to execute.
- `--timeout-ms N` (default 60000), `--json <path>`, `--markdown <path>`.

The runner launches `@playwright/test`'s Chromium with an ephemeral profile —
no browser downloads. Point `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` at a
native-capable Chrome/Chromium build to exercise the real WebMCP API.

## What the runner enforces

- Every request/redirect is validated against an exact-origin allowlist via
  route interception; undeclared subresource and websocket attempts are
  aborted and recorded (the trap fixture `undeclared-subresource.html`
  demonstrates this — its `webmcp.declared-origins` check FAILs by design).
- Passive mode (default) loads each page, observes `document.modelContext`,
  and enumerates registered tools without executing anything mutating.
- The receipt stores origins only (path/query/fragment dropped; userinfo
  rejected), an optional sha256 fixture-set checksum plus git revision for
  identity — never cookies, tokens, raw page source, or tool I/O bodies.

## Receipt fields

| field                                       | meaning                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `runId`, `checkedAt`                        | invocation identity                                                      |
| `browser.{name,version,nativeApiAvailable}` | exact browser under test and whether `document.modelContext` existed     |
| `target.{origin,revision,contentChecksum}`  | sanitized origin plus optional content identity bindings                 |
| `checks[]`                                  | one entry per check: `id`, `state`, `method:"native-browser"`, `summary` |
| `limits.{timedOut,skipped}`                 | wall-time limit reached / check ids never executed                       |

Check states:

- `PASS` — the check actually executed and observed the claimed behavior.
  For native-WebMCP checks that means the real API on a native-capable
  browser — a JS shim never produces a native-browser PASS.
- `FAIL` — an observed violation (undeclared-origin request attempted, a
  tool executed during passive observation, a page that failed to load).
- `INCONCLUSIVE` — no evidence could be produced, e.g. `native WebMCP API
unavailable in chromium <version>` on stock Chromium.
- `NOT_APPLICABLE` — the check does not apply to this fixture.

Exit codes: `0` = no FAIL (a PASS/INCONCLUSIVE mix is a successful run);
`1` = at least one FAIL or a runner-internal failure; `2` = usage error.

## Caveats

- A receipt covers exactly the named checks, browser version, fixture
  content (when bound), and invocation — it is not proof of universal
  safety, other browsers, or other content.
- `nativeApiAvailable: false` means no native-WebMCP claim was tested; on
  the stock Playwright Chromium every native-dependent check is
  INCONCLUSIVE by design.
- A receipt supplied by a customer is untrusted external evidence: validate
  it (`validateWebMcpRuntimeReceipt`) and treat its claims as unverified
  until independently reproduced.
