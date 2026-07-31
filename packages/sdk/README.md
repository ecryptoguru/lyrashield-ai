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

The client always prepends `/api/v1` to bare paths, so callers should pass paths like `/findings` instead of `/api/v1/findings`.

## Main exports

- `LyraShieldClient`, `LyraShieldClientOptions`, `RequestOptions`
- `LyraShieldError`, `NotModified`, `isNotModified`
- `paginate`, `listAll`
- Resource helpers in `src/resources/*`

## See also

- `packages/cli/README.md`
- `packages/mcp/README.md`
- `docs/api-stability.md`
