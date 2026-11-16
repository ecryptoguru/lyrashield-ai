# Official MCP Registry preparation

**State: CANDIDATE; NPM PUBLICATION AND REGISTRY SUBMISSION PENDING.** `@lyrashield/mcp@0.2.13` carries `mcpName: io.github.ecryptoguru/lyrashield-ai` and the current 22-tool catalog. Its prepared Registry metadata remains an offline release candidate. The earlier 0.2.12 package was published and passed publisher validation; those receipts do not establish publication of 0.2.13. Authenticate, publish the reviewed npm bytes, submit and read back the public Registry version before claiming availability.

## Verified identities and endpoints

- Source repository: https://github.com/ecryptoguru/lyrashield-ai (git remote origin).
- Hosted product domain: https://lyrashieldai.com.
- Candidate stdio package: @lyrashield/mcp 0.2.13 includes the 22-tool catalog. npm publication and registry readback are pending; the prior 0.2.12 publication was verified on 2026-10-02.
- Hosted MCP endpoint: https://app.lyrashieldai.com/api/mcp, documented by the current MCP package README. It uses Streamable HTTP and hosted OAuth discovery; the Registry remote intentionally declares no static bearer header or secret.
- Candidate Registry name: io.github.ecryptoguru/lyrashield-ai, matching the official GitHub username namespace pattern. This is a prepared identity, not proof of namespace ownership or publication.
- The exact prepared identity readback returned HTTP 404 and public search returned no LyraShield entry on 2026-10-02. This verifies absence for the prepared identity, not every possible alternate identity.

The manifest lists both transports: npm stdio for clients that can run Node.js 24 or newer, and the hosted Streamable HTTP endpoint for clients that support remote MCP and OAuth. The Registry carries discovery metadata only; it does not publish the npm artifact or establish client compatibility, OAuth success or marketplace acceptance. The official Registry remains documented as preview, so recheck its schema and CLI before submission.

## Offline validation

The official Registry JSON Schema is vendored at [schema/server.schema.json](./schema/server.schema.json). Its provenance and SHA-256 are recorded in [schema/PROVENANCE.md](./schema/PROVENANCE.md). From the product repository root, run:

    pnpm exec node docs/marketplace/mcp-registry/validate.mjs

This uses the existing Ajv dependency in @lyrashield/agent-plugin, validates against the vendored official schema, verifies the vendored checksum and checks that the metadata version matches the local package. Release-ready mode reads public npm metadata to prove the published version exposes the same marker. It passed on 2026-10-02:

    pnpm exec node docs/marketplace/mcp-registry/validate.mjs --release-ready

These offline checks run from the LyraShield AI source checkout. The maintainer validator is omitted
from the public marketplace export; the exported bundle includes `server.json` and the schema for
review and official publisher validation.

The official publisher validator also passed from this directory on 2026-10-02:

    mcp-publisher validate

Only an authenticated `mcp-publisher publish` and public Registry API readback can change the listing state from READY to PUBLISHED. Authentication and publication are still outstanding.

## Submission sequence

1. Authenticate with GitHub as the namespace owner using the official publisher flow.
2. Reconfirm both server.json version fields match `@lyrashield/mcp@0.2.13` and rerun both validators.
3. Publish the reviewed package using the authenticated official CLI.
4. Read back the exact public version and URL from the Registry API; record it in the [distribution channel ledger](https://github.com/ecryptoguru/lyrashield-ai/blob/main/docs/marketplace/channels.md).

Official references: [Registry quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx), [generic server.json format](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md) and [Registry package ownership rules](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx).
