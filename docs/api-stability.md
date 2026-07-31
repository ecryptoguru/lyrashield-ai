# API Stability Policy

## `/api/v1` — additive-only

The `/api/v1` surface is **additive-only**. We will not remove fields, rename paths, change the meaning of status codes, or narrow the set of allowed request shapes in a v1 route.

- New fields may be added to existing response envelopes.
- New query parameters, headers, and optional request-body fields may be added.
- New v1 routes may be introduced.
- Existing routes may return additional non-breaking status codes.

Any change that would cause a correctly written v1 client to break must ship as `/api/v2`.

## Breaking changes require a new version

A breaking change is one that would:

- Remove or rename an existing v1 path or HTTP method.
- Remove a field from a response or make a previously optional field required.
- Change the type, format, or meaning of an existing field.
- Remove a previously returned status code or change its semantics.
- Tighten validation in a way that rejects previously valid requests.

When a breaking change is needed, it is introduced under a new `/api/v2` prefix. The previous `/api/v1` route remains available for a deprecation window.

## Deprecation window

A v1 endpoint, field, or status code may be deprecated, but it will not be removed without:

- A minimum **90-day notice** from the date the deprecation is published.
- Documentation in the OpenAPI spec (`/api/v1/openapi.json`) with `deprecated: true`.
- A changelog entry in this file and release notes.
- A migration path documented for integrators.

After the 90-day window, the deprecated surface may be removed from v1. If removal would break clients, it is preserved and a v2 alternative is provided instead.

## Client-side path normalization changelog

The public `/api/v1` URL surface is unchanged. Client-side changes that do not affect the wire contract are recorded here for integrators and operators:

- **2026-07-31 — CLI and MCP path normalization:** The CLI and MCP server now pass bare API paths (e.g., `/findings`) to the `@lyrashield/sdk` client, which continues to prepend `/api/v1` in `buildUrl()`. This fixes an earlier double-prefix bug where some tool calls produced `/api/v1/v1/...` paths. Existing v1 route URLs remain valid.

## No migrations in the API contract

Breaking API changes are handled by versioning, not by data migrations or automatic redirects. Clients choose the version they call.
