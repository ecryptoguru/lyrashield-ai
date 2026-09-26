# WebMCP runtime-check fixtures

Customer-controlled-style static pages exercised by
`scripts/webmcp-runtime-check.mjs`. They are instrumented but inert: handlers
only write to `window.__toolCalls`/`window.__webmcpFixture`, never touch the
network, credentials, payments, uploads, deletions, or any real scan
submission. All data is synthetic.

## Fixture inventory

| File                          | Purpose                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `instrument.js`               | Shared hook: `registerFixtureTool()` registers through `document.modelContext` when present; `window.__invokeTool(name, input, {abortAfterMs})` is the test hook active mode uses to call a stored execute callback (the native dispatch path is not callable from page JS). `__toolCalls` proves whether a handler ran. |
| `registered-tools.html`       | `fixture_lookup_status` (readOnlyHint) + `fixture_update_record` (mutating-looking). Passive mode must enumerate without executing — `__toolCalls` stays empty.                                                                                                                                                          |
| `invalid-input.html`          | `fixture_strict_echo` requires `{message: string, ≤64}`. Active mode can send a malformed input and confirm rejection is observable.                                                                                                                                                                                     |
| `abort-signal.html`           | `fixture_slow_task` waits ~8s but honors AbortSignal (`window.__abortObserved`). Active mode schedules `abortAfterMs` to verify cancel propagation.                                                                                                                                                                      |
| `human-confirm.html`          | `fixture_delete_draft` documents "requires human confirmation". The runner treats that as an unverified claim: passive never executes it; active runs it only when explicitly allowlisted.                                                                                                                               |
| `no-webmcp.html`              | Control page: registers nothing; performs one same-origin fetch of `fixture-data.json` to prove declared same-origin subresources still pass.                                                                                                                                                                            |
| `undeclared-subresource.html` | Trap: attempts requests to `*.invalid` origins outside the allowlist. Every attempt must be blocked+recorded; the `webmcp.declared-origins` check FAILs by design for this fixture.                                                                                                                                      |
| `fixture-data.json`           | Synthetic payload for the same-origin fetch.                                                                                                                                                                                                                                                                             |

## Reproduce

```sh
node scripts/webmcp-runtime-check.mjs \
  --fixture-dir e2e/webmcp-runtime/fixtures \
  --json /tmp/webmcp-receipt.json --markdown /tmp/webmcp-receipt.md
```

The runner serves only this directory on an ephemeral `127.0.0.1` port,
navigates each `*.html`, and writes a `lyrashield-webmcp-runtime/1` receipt.

## Supported browsers / flags

WebMCP (`document.modelContext`) is an experimental Chrome API. Stock
Playwright Chromium does **not** implement it: the receipt then records
`browser.nativeApiAvailable: false` and every native-dependent check comes
back `INCONCLUSIVE` (`native WebMCP API unavailable in …`), while
harness-level checks (page load, declared-origin enforcement,
no-execution) still PASS.

To run against a WebMCP-capable browser build, point the runner at it:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome-with-webmcp \
  node scripts/webmcp-runtime-check.mjs --fixture-dir e2e/webmcp-runtime/fixtures --json out.json
```

On such a build, registered tools actually register natively and
enumeration/active checks can PASS. A JavaScript shim of the API is only
valid for unit tests of fixture logic — it never produces a
`native-browser` PASS receipt.

## Active mode (opt-in per tool)

```sh
node scripts/webmcp-runtime-check.mjs \
  --fixture-dir e2e/webmcp-runtime/fixtures \
  --target /invalid-input.html \
  --active-tool fixture_strict_echo --active-input '{"message":42}' \
  --active-tool fixture_slow_task --active-abort-ms 200
```

Only the named tools run, only on a native-capable browser, only through
the fixture's `__invokeTool` hook. `--active-input` supplies the tool input
JSON; `--active-abort-ms` schedules the AbortSignal for cancel checks.
