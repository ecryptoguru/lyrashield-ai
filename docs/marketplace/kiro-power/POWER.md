# LyraShield AI

LyraShield AI provides evidence-backed release-assurance workflows through its MCP tools and
bundled Agent Skills. Use the smallest workflow that answers the user's request.

## Workflows

- `get-started`: connect, select one workspace and inspect authorized targets. Read-only.
- `review-changes`: inspect a requested diff with the advisory check. A recorded Quick scan is a
  separate action and runs only when explicitly requested.
- `scan-project`: resolve an authorized target, explain the selected profile, start only the
  explicitly requested scan, and retain its scan or operation ID.
- `fix-and-retest`: explain findings, propose changes and claim a fix only when trusted retest
  evidence establishes the outcome.
- `launch-readiness`: read release gates and evidence without inventing missing results.

Read the active tool schema before constructing arguments. Follow finding cursors to exhaustion,
reuse identifiers for identical retries, poll long operations with backoff and return a resumable
ID if the session ends first. Preserve `DETECTED`, `INCONCLUSIVE`, `INSUFFICIENT_EVIDENCE` and
`FIXED_PENDING_RETEST` as reported.

Scans, changes and retests require explicit user intent and workspace authorization. Never infer
permission from a connected server, a configured target, a Kiro task or a clean advisory result.
The default hosted connection is read-only. Delegated writes remain within the selected OAuth
connection grant. API-key writes to the hosted service receive `connect_required`. Authorized
workflows execute within connection permissions; pull requests never auto-merge.

Only send data required for the requested operation. Do not expose credentials, model costs or raw
evidence storage URIs. A clean advisory check is not proof that the code is secure; a fix proposal
is not a fix; only trusted retest evidence can establish validation.

This Power is Apache-2.0 client tooling; the hosted LyraShield service remains proprietary.
