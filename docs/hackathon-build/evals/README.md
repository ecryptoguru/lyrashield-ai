# WebMCP Assurance evaluation corpus

This directory contains the evaluation corpus for the WebMCP Assurance hackathon deliverable. It is intended to be filled in with observed results during manual and automated evaluation; the `expectedTool` and `expectedBehavior` fields state the intended behavior before runtime evidence is collected.

## Files

- `webmcp-prompts.json` — focused tool-selection, parameter, cancellation, and human-confirmation cases for the public Security Lab and the authenticated dashboard.
- `adversarial-prompts.json` — prompt-injection and content-injection attempts against discovered tool descriptions, finding text, and source inputs.

## Evaluation clients

- `chrome-webmcp-inspector` — Chrome DevTools-style WebMCP schema and tool-selection inspector.
- `chatgpt-in-app-browser` — ChatGPT in-app browser visiting the public `/webmcp` page or the dashboard.
- `playwright-automation` — Playwright browser automation for accessibility, privacy, and UI-state checks.
- `node-cli` — `@lyrashield/cli` `check-diff` and `gate` runs on fixtures.
- `vitest` — deterministic unit and integration tests in `packages/security`.

## Required metadata per prompt

- `client` and `browser` (when applicable).
- `exactRevisionSha` pinned at evaluation time.
- `prompt` and `expectedTool`/`expectedBehavior`.
- `observedTool`, `observedParams`, `result`, `uiEffect`, and `receipt` filled after observation.
- `pass` derived from expected vs. observed; `notes` capture limitations.

## Classification of receipts

- `read` — tool returned visible information.
- `ui-only` — tool changed UI state (filters, selection, form preparation) without durable mutation.
- `prepared` — tool prepared a durable action and stopped for explicit human confirmation.
- `cancelled` — tool or user cancelled before mutation.
- `mutation` — durable action executed. Should require prior confirmation in all supported flows.

## Privacy assertions

- Source text, pasted code, local files, and full finding details must never be uploaded to any server.
- Only aggregate events (tool availability, name, duration bucket, status) may go to existing analytics.
- Workspace IDs, API keys, target URLs, and receipt contents must not appear in prompts, outputs, or analytics.
