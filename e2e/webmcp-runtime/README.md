# WebMCP native runtime check

This optional local QA command opens an ephemeral Chromium profile. It visits only the exact `127.0.0.1` origin supplied, blocks redirects and requests to other origins, blocks service workers and WebSockets, and writes a bounded JSON receipt. No source, cookies, tool inputs, or tool outputs are exported. The local static checker remains a separate analysis; neither result verifies a security finding or authorizes a release gate.

Use Chrome 149+ with WebMCP enabled. [Chrome's WebMCP guide](https://developer.chrome.com/docs/ai/webmcp) documents `chrome://flags/#enable-webmcp-testing` for local development. A browser without the native API or Chrome WebMCP protocol yields `INCONCLUSIVE`, never a native PASS.

```sh
node scripts/webmcp-runtime-check.mjs --fixture \
  --browser '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --output /tmp/webmcp-fixture-receipt.json
```

The fixture is synthetic: one echo tool, one cancellable read, one visible confirmation, a private cross-origin iframe, and route cleanup. It sends no payments, uploads, scans, or production credentials. An observed failure is retained as `FAIL`; browser versions may differ.

For your own local fixture, start its server at a numeric loopback origin. Passive mode discovers native registrations without invoking tools:

```sh
node scripts/webmcp-runtime-check.mjs --origin http://127.0.0.1:4567 \
  --browser /path/to/Chrome --revision YOUR_REVISION \
  --output /tmp/webmcp-receipt.json
```

To execute a safe synthetic tool, explicitly name it and provide a JSON file mapping names to synthetic inputs:

```sh
node scripts/webmcp-runtime-check.mjs --origin http://127.0.0.1:4567 \
  --browser /path/to/Chrome --active-tool safe_lookup \
  --input-file /tmp/synthetic-webmcp-inputs.json \
  --output /tmp/webmcp-active-receipt.json
```

Do not use active mode against a server connected to real accounts, payments, uploads, or scans. The runner does not infer safety from `readOnlyHint`. Only named tools execute. Outputs are measured, then discarded. The receipt is untrusted local evidence, scoped to its browser, origin, revision or checksum if supplied, and specific checks. Unsupported checks remain explicit. Output paths must be new; the command never overwrites a receipt.

An owned HTTPS staging fixture is opt-in. Repeat its exact origin in `--allow-origin`, declare ownership, and use only synthetic accounts/data:

```sh
node scripts/webmcp-runtime-check.mjs --origin https://staging.example.com \
  --allow-origin https://staging.example.com --owned-staging \
  --browser /path/to/Chrome --output /tmp/webmcp-staging-receipt.json
```

The runner requires all DNS A records to be public, pins Chromium to one address, disables proxy use, and blocks all undeclared request origins, redirects, and WebSockets. DNS or browser failures yield `INCONCLUSIVE`. It never reads real browser profiles or credentials.
