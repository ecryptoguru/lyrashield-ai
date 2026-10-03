# LyraShield AI for v0 — preparation

**State: PREPARATION.** v0's bring-your-own MCP route has a hosted OAuth connection snippet below. It is a human-readable reference, not an importable v0 configuration file. No v0 client-runtime receipt or Vercel Marketplace application/listing is confirmed.

## Connect the hosted MCP server

In v0, use **Add MCP** from a prompt or open MCP Connections in settings. Add the server URL from [`connection-details.json`](./connection-details.json), choose OAuth and complete the LyraShield sign-in and workspace selection in the authorization flow. Do not paste an API key into the config. Keep v0's tool permission mode at **Ask for Approval (Manual)** while evaluating the connection.

This connector makes MCP tools available to v0 while it generates or edits a project. v0's MCP documentation says generated code cannot call the connected tools at application runtime. If a built application needs a LyraShield integration, that requires a separate product/API design; do not copy the v0 chat connector or its OAuth credentials into generated code.

## Marketplace application packet

The Vercel Marketplace has its own provider intake and review path. MCP compatibility with v0 does not make LyraShield a Vercel Marketplace integration. The public requirements distinguish **connectable account integrations** from **native integrations**. Native marketplace products need an integration server implementing Vercel's Marketplace API; native products also involve account/resource setup, lifecycle and billing flows. Do not start implementation or submit the application until the founder chooses the product type, confirms publisher/legal details and reviews any marketplace agreement.

[`vercel-marketplace/application.md`](./vercel-marketplace/application.md) contains a draft profile and the open fields. It is not a submitted application. No category, billing model, integration type, support SLA, legal publisher name or listing approval is represented as final.

## Evidence and sources

Checked 2026-10-01. v0's docs support custom remote MCP servers with OAuth, while the Vercel application details still need product and legal review. See [v0 MCP Integrations](https://v0.app/docs/MCP), [Vercel Marketplace Program](https://vercel.com/marketplace/program), [Vercel integration types](https://vercel.com/docs/integrations), [native integration requirements](https://vercel.com/docs/integrations/create-integration/marketplace-product) and [listing requirements](https://vercel.com/docs/integrations/create-integration/submit-integration).
