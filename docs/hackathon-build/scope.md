# Project Scope

## Project Name Candidates

- Founder decision required. The working capability name in product documents is **WebMCP Assurance**; this is not the final Devpost project name.

## One-Line Summary

LyraShield AI inventories, analyzes, gates, improves, and reports on WebMCP tool surfaces while also exposing safe, page-aware LyraShield workflows to browser agents under the user's existing permissions and explicit approval boundaries.

## Target User

- Developers and teams adding WebMCP tools to production web applications.
- Security and platform teams reviewing agent-accessible browser actions.
- LyraShield users who want an agent to understand findings, launch readiness, and scan preparation without fragile DOM automation.
- Developers evaluating WebMCP locally before connecting a repository or enabling CI.

## Problem

WebMCP makes browser applications easier for agents to operate, but it also creates a new security and product surface: tool descriptions can misrepresent behavior, schemas can be overly broad, external content can enter model context without warning, cross-origin exposure can leak capabilities, mutations can occur without a clear human boundary, and tools can ignore cancellation or lifecycle cleanup. Existing source scanners generally do not inventory this surface, bind it to evidence, propose safe changes, gate regressions in CI, and carry the results into durable security reports.

At the same time, LyraShield's own browser experience is still primarily human-actuated. Its existing authenticated APIs and MCP server are strong foundations, but browser agents visiting the product should receive a smaller, page-specific tool set that reflects what the user can currently see and do.

## Core Workflow

1. A developer pastes or selects WebMCP source in the public local checker, or connects a repository for a full LyraShield scan.
2. LyraShield discovers WebMCP registrations and produces a bounded tool-surface inventory with source locations and schema hashes.
3. A deterministic policy engine evaluates 14 controls and returns `DETECTED`, `NO_FINDING`, `INCONCLUSIVE`, or `NOT_ASSESSED` with coverage and limitations.
4. LyraShield prepares deterministic safe rewrite proposals for supported controls. The developer reviews and copies or applies them through an existing approval-bound workflow.
5. CLI and GitHub Action checks identify newly introduced WebMCP regressions, emit SARIF, and enforce only high-confidence findings at the configured threshold.
6. Full scans preserve WebMCP findings and coverage in the existing evidence lifecycle and include a WebMCP Tool Surface section in security reports.
7. Inside LyraShield, page-specific WebMCP tools let an authenticated browser agent read launch readiness, filter and explain findings, and prepare a scan. Any resource-consuming or durable mutation still requires the visible human confirmation already owned by the product.
8. A visible activity surface tells the user which page tool ran, what class of data it handled, whether it changed UI state, and whether a durable action is still awaiting approval.

## What We Are Building

- A shared, browser-compatible deterministic WebMCP analyzer with 10 versioned controls.
- A tool-surface inventory containing registrations, annotations, schemas, source locations, behavior classification, exposure, and a stable definition hash.
- A public no-login WebMCP Security Lab and free local checker with file and paste modes.
- Deterministic safe rewrite proposals with before/after diff, limitations, and no automatic repository mutation.
- Full repository integration through the existing AI App Security scan family, coverage receipt, findings, and evidence model.
- CLI changed-file analysis, SARIF output, threshold enforcement, and GitHub Action coverage for high-confidence rules.
- WebMCP sections in existing developer, executive, and compliance reports; no new report type.
- One focused page-scoped WebMCP tool each for launch-readiness review, findings review, and scan preparation.
- Existing-permission access only: the browser tools never create a broader authorization channel.
- Human confirmation for scans and every other durable or resource-consuming mutation.
- Visible session receipts for all WebMCP executions and durable audit rows for approved mutations through existing server paths.
- Explicit WebMCP origin-isolation and permissions-policy hardening, without misclassifying safe browser defaults as vulnerabilities.
- Unit, integration, CI, browser, agent-prompt evaluation, deployment, runtime, and visual evidence.
- Public documentation describing the new work added during the hackathon period and its limitations.
- A featured WebMCP Security section in Free Tools, one canonical interactive checker, one substantial `/webmcp` pillar page, and a generated public control registry wired into existing sitemap, structured-data, `llms.txt`, and internal-link systems.
- Frictionless public judging plus a dedicated ordinary user in an isolated synthetic workspace for authenticated testing; no privileged judge role, authentication bypass, or production demo seed.

## What We Are Not Building

- No duplicate of all 14 hosted MCP tools in the browser; WebMCP remains page-scoped and task-specific.
- No embedded general chatbot; users bring a WebMCP-capable browser agent.
- No wildcard cross-origin exposure or arbitrary-site WebMCP crawling. WebMCP origin rules make remote enumeration an invalid product claim.
- No automatic purchase, report sharing, PR creation, scan, retest, deletion, or message sending from a browser tool.
- No model-generated patch applied without review. Version one uses deterministic rewrites; model-assisted adaptation can be evaluated later.
- No new database report type or parallel evidence system.
- No claim that WebMCP directly improves AEO/GEO ranking or that a clean result proves security.
- No production admission, billing, or unrelated launch changes.

## Inspiration And References

- WebMCP's imperative API for page-state tools and lifecycle-aware registration.
- WebMCP's declarative API for visible form preparation and human submission.
- Chrome guidance on focused tools, runtime validation, cancellation, read-only and untrusted-content annotations, origin exposure, and bounded descriptions and outputs.
- LyraShield's existing MCP approval model, AI App Security scanner, evidence states, SARIF gate, and immutable report snapshots.

## Demo Path

1. Open the public WebMCP Security Lab in a supported browser agent.
2. Ask the agent to inspect an intentionally unsafe tool definition; the agent calls the registered local analyzer and the visible inventory and findings update.
3. Ask for a safe rewrite; the agent prepares a deterministic before/after patch in the editor without modifying a repository.
4. Show the same controls detecting a real repository fixture and producing SARIF/CI output.
5. Open authenticated LyraShield and ask what blocks launch; the page tool returns the bounded readiness state and filters the visible findings.
6. Ask the agent to prepare a scan; the form is filled, the receipt says human confirmation is required, and no job starts until the user clicks.
7. Open the durable report and show the WebMCP Tool Surface inventory, coverage, findings, and limitations bound to the scan snapshot.

## Submission Story

WebMCP turns web pages into agent-operable applications. LyraShield makes the resulting tool surface observable and governable: developers can see what capabilities they exposed, detect dangerous contracts, receive safe proposals, prevent regressions in CI, preserve evidence in reports, and still let agents operate LyraShield through narrowly scoped browser tools. The distinguishing feature is the end-to-end chain from source definition to browser interaction, human approval, CI gate, and evidence-backed assurance report.
