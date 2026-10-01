# Official MCP Registry preparation

**State: PREPARATION. Do not publish this metadata as-is.** The published npm release `0.2.11` is immutable and does not carry the Registry ownership marker. The local `0.2.12` release candidate adds `mcpName: io.github.ecryptoguru/lyrashield-ai`; its Registry metadata is prepared at the same candidate version. The marker and version must be confirmed in the published npm package before any submission or readback claim.

## Verified identities and endpoints

- Source repository: https://github.com/ecryptoguru/lyrashield-ai (git remote origin).
- Hosted product domain: https://lyrashieldai.com.
- Published stdio baseline: @lyrashield/mcp 0.2.11; npm view returned 0.2.11 on 2026-10-01. Local candidate: 0.2.12 (unpublished).
- Hosted MCP endpoint: https://app.lyrashieldai.com/api/mcp, documented by the current MCP package README. It uses Streamable HTTP and hosted OAuth discovery; the Registry remote intentionally declares no static bearer header or secret.
- Candidate Registry name: io.github.ecryptoguru/lyrashield-ai, matching the official GitHub username namespace pattern. This is a prepared identity, not proof of namespace ownership or publication.
- Public Registry search for io.github.ecryptoguru/lyrashield-ai returned {"servers":[],"metadata":{"count":0}} on 2026-10-01.

The manifest lists both transports: npm stdio for clients that can run Node.js 24 or newer, and the hosted Streamable HTTP endpoint for clients that support remote MCP and OAuth. The Registry carries discovery metadata only; it does not publish the npm artifact or establish client compatibility, OAuth success, or marketplace acceptance. The official Registry remains documented as preview, so recheck its schema and CLI before submission.

## Offline validation

The official Registry JSON Schema is vendored at [schema/server.schema.json](./schema/server.schema.json). Its provenance and SHA-256 are recorded in [schema/PROVENANCE.md](./schema/PROVENANCE.md). From the product repository root, run:

    pnpm exec node docs/marketplace/mcp-registry/validate.mjs

This uses the existing Ajv dependency in @lyrashield/agent-plugin, validates against the vendored official schema, verifies the vendored checksum, and checks that the metadata version matches the local package. In preparation mode, it verifies the local marker and candidate version. Release-ready mode also reads public npm metadata to prove the published candidate version exposes the same marker. Once a release includes it, run:

    pnpm exec node docs/marketplace/mcp-registry/validate.mjs --release-ready

These offline checks run from the LyraShield AI source checkout. The maintainer validator is omitted
from the public marketplace export; the exported bundle includes `server.json` and the schema for
review and official publisher validation.

Then run the official publisher's validation from this directory (after installing the official publisher CLI and confirming server.json matches the released package version):

    mcp-publisher validate

Only a subsequent authorized mcp-publisher publish and public Registry API readback can change the listing state from preparation. Neither command is run by this preparation task.

## Submission sequence

1. Publish the reviewed `@lyrashield/mcp@0.2.12` candidate with the ownership marker; never rewrite published `0.2.11`.
2. Confirm both server.json version fields already match that exact npm release.
3. Run both offline validation modes and mcp-publisher validate.
4. Authenticate with GitHub under ecryptoguru and publish only after the separate release/submission review.
5. Read back https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.ecryptoguru/lyrashield-ai; record the public version and URL in [../channels.md](../channels.md).

Official references: [Registry quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx), [generic server.json format](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md), and [Registry package ownership rules](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx).
