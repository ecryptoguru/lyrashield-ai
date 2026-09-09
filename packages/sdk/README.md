# @lyrashield/sdk

Shared LyraShield HTTP client used by the CLI (`packages/cli`) and MCP server (`packages/mcp`).

## Purpose

- Provides `LyraShieldClient`, the authenticated HTTP client that calls the LyraShield API.
- Handles request signing, retries with exponential backoff, `Retry-After` handling, and `ETag`-based caching.
- Exports typed resource helpers for scans, findings, targets, reports, fix proposals, retests, schedules, projects, workspaces, launch readiness, and agent approvals.
- Defines `LyraShieldError`, `NotModified`, and domain-specific error helpers.

## Usage

```ts
import { LyraShieldClient, LyraShieldError } from "@lyrashield/sdk"

const client = new LyraShieldClient({
  apiKey: process.env.LYRASHIELD_API_KEY!,
  apiUrl: process.env.LYRASHIELD_API_URL, // defaults to https://app.lyrashieldai.com
})

const finding = await client.request("GET", "/findings/fnd_...")
```

The client always prepends `/api/v1` to bare paths, so callers should pass paths like `/findings` instead of `/api/v1/findings`. If you accidentally pass an already-prefixed path such as `/api/v1/findings` or `/api/findings`, the client throws a `LyraShieldError` with `code: "INVALID_PATH"` before any network request is made.

## Main exports

- `LyraShieldClient`, `LyraShieldClientOptions`, `RequestOptions`
- `LyraShieldError`, `NotModified`, `isNotModified`
- `paginate`, `listAll`
- `parseRepoIdentifier`, `ParsedRepo` — parse bare `owner/repo` strings, HTTPS/SSH git URLs, and GitLab nested groups into `{ repoProvider, repoOwner, repoName, repoFullName }`
- Resource helpers in `src/resources/*`

## See also

- `packages/cli/README.md`
- `packages/mcp/README.md`
- `docs/api-stability.md`

### Durable request retries

Scan, report, retest, and fix-proposal creation accept an optional `idempotencyKey`. Keep this key with the request and reuse it with identical inputs after a lost response or process restart. Each SDK invocation without a supplied key generates a new request key. An uncertain operation must be inspected before starting another operation.

`getOperationStatus(client, operationId, workspaceId)` validates the shared operation-status response, including the server-owned recovery decision. Operation lookup requires the original principal and current workspace access; it does not grant access through a different credential.
