import { fixtureActionIntentPublisher, fixtureAuthorityFence } from "./test-fixtures"
import { createServer } from "node:http"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { describe, it, expect } from "vitest"
import { SignedJournal } from "@lyrashield/runtime-control"
import { createProviderGatewayHandler } from "./http"
import { ProviderGatewayService, providerJournalEventSchema } from "./service"
import { fixturePolicy } from "./test-fixtures"

const run = promisify(execFile)
const engine = process.env.LYRASHIELD_ENGINE_CHECKOUT
const python = process.env.LYRASHIELD_ENGINE_PYTHON

describe.skipIf(!engine && !python)("engine-to-gateway HTTP contract", () => {
  it.each([
    {
      streaming: false,
      tool: false,
      structured: false,
      custom: false,
      shell: false,
      patch: false,
      authorityLost: false,
    },
    {
      streaming: true,
      tool: false,
      structured: false,
      custom: false,
      shell: false,
      patch: false,
      authorityLost: false,
    },
    {
      streaming: false,
      tool: true,
      structured: false,
      custom: false,
      shell: false,
      patch: false,
      authorityLost: false,
    },
    {
      streaming: false,
      tool: false,
      structured: true,
      custom: false,
      shell: false,
      patch: false,
      authorityLost: false,
    },
    {
      streaming: false,
      tool: false,
      structured: false,
      custom: true,
      shell: false,
      patch: false,
      authorityLost: false,
    },
    {
      streaming: false,
      tool: false,
      structured: false,
      custom: false,
      shell: true,
      patch: false,
      authorityLost: false,
    },
    {
      streaming: false,
      tool: false,
      structured: false,
      custom: false,
      shell: false,
      patch: true,
      authorityLost: false,
    },
    {
      streaming: false,
      tool: false,
      structured: false,
      custom: false,
      shell: false,
      patch: false,
      authorityLost: true,
    },
  ])(
    "real SDK to local gateway, streaming=$streaming tool=$tool structured=$structured custom=$custom shell=$shell patch=$patch authorityLost=$authorityLost",
    async ({ streaming, tool, structured, custom, shell, patch, authorityLost }) => {
      if (!engine || !python)
        throw new Error("both engine checkout and Python interpreter are required")
      const root = await mkdtemp(join(tmpdir(), "gateway-bridge-"))
      const journal = new SignedJournal(join(root, "journal"), "s".repeat(48), (value) =>
        providerJournalEventSchema.parse(value)
      )
      const policy = {
        ...fixturePolicy,
        adapter: "responses-agent-v1" as const,
        endpoint: "/openai/v1/responses",
        maxInputTokens: 8192,
        maxOutputTokens: 128,
        deadlineMs: 15_000,
        idleTimeoutMs: 5_000,
      }
      let calls = 0
      const capturedBodies: string[] = []
      const response = {
        id: "r",
        object: "response",
        created_at: 0,
        model: "gpt-6-luna",
        status: "completed",
        output: [
          {
            id: "m",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: structured
                  ? JSON.stringify({
                      is_duplicate: false,
                      duplicate_id: "",
                      confidence: 0,
                      reason: "synthetic",
                    })
                  : "OK",
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 8,
          output_tokens: 2,
          total_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
        },
      }
      const service = new ProviderGatewayService({
        journal,
        publishActionIntent: fixtureActionIntentPublisher,
        authorityFence: authorityLost
          ? {
              run: async (binding, work) => {
                await work(() => undefined, { guardId: `fixture-${binding.requestId}` })
                throw new Error("lost authority acknowledgement")
              },
            }
          : fixtureAuthorityFence,
        signingSecret: "s".repeat(48),
        responseEncryptionSecret: "e".repeat(48),
        admission: "open",
        providers: new Map([
          [
            "azure-ai",
            {
              id: "azure-ai",
              baseUrl: "https://provider.example.test",
              auth: { kind: "authorization", credential: "synthetic" },
              allowedPathPrefixes: ["/openai/"],
              requestPolicy: policy,
            },
          ],
        ]),
        authorizeGrant: async () => policy,
        fetchImpl: async (_url, init) => {
          calls++
          const request = JSON.parse(Buffer.from(init!.body as Uint8Array).toString())
          const output =
            (tool || custom || shell || patch) && calls === 1
              ? [
                  patch
                    ? {
                        type: "apply_patch_call",
                        id: "fc_1",
                        call_id: "call_1",
                        operation: {
                          type: "create_file",
                          path: "synthetic.txt",
                          diff: "+synthetic",
                        },
                        status: "completed",
                      }
                    : shell
                      ? {
                          type: "shell_call",
                          id: "fc_1",
                          call_id: "call_1",
                          action: { commands: ["echo synthetic"] },
                          status: "completed",
                        }
                      : custom
                        ? {
                            type: "custom_tool_call",
                            id: "fc_1",
                            call_id: "call_1",
                            name: "echo",
                            input: "synthetic",
                          }
                        : {
                            type: "function_call",
                            id: "fc_1",
                            call_id: "call_1",
                            name: "echo",
                            arguments: JSON.stringify({ value: "synthetic" }),
                            status: "completed",
                          },
                ]
              : response.output
          const result = { ...response, id: `response-${calls}`, output }
          return request.stream
            ? new Response(
                `data: ${JSON.stringify({ type: "response.completed", response: result, sequence_number: 0 })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } }
              )
            : new Response(JSON.stringify(result), {
                headers: { "content-type": "application/json" },
              })
        },
      })
      const grant = await service.issueGrant({
        grantRequestId: "grant-fixture-1",
        attemptId: "attempt-fixture-1",
        scanId: "scan-fixture-1",
        workspaceId: "workspace-fixture-1",
        operationId: "operation-fixture-1",
        authorityEpochId: "epoch-fixture-1",
        authorityRevision: 1,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        providerId: "azure-ai",
        maxRequests: 10,
        costReservationMicros: 0,
        maxReservedCostMicros: 10_000,
      })
      const handler = createProviderGatewayHandler(service, {
        controlToken: "x".repeat(48),
        admission: "open",
      })
      const server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => capturedBodies.push(Buffer.concat(chunks).toString()))
        handler(request, response)
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      try {
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("no port")
        const probe = run(python, [resolve(".github/scripts/engine-gateway-http-probe.py")], {
          cwd: engine,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: await realpath(tmpdir()),
            PYTHONPATH: engine,
            LYRASHIELD_PROVIDER_GATEWAY_ORIGIN: `http://127.0.0.1:${address.port}`,
            PROBE_SCAN_ID: "scan-fixture-1",
            PROBE_GRANT: grant.token,
            PROBE_STREAM: streaming ? "1" : "0",
            PROBE_TOOL: tool ? "1" : "0",
            PROBE_STRUCTURED: structured ? "1" : "0",
            PROBE_CUSTOM: custom ? "1" : "0",
            PROBE_SHELL: shell ? "1" : "0",
            PROBE_PATCH: patch ? "1" : "0",
          },
          timeout: 30_000,
        })
        if (authorityLost) await expect(probe).rejects.toThrow()
        else
          await probe.catch((error: unknown) => {
            throw new Error(
              `Synthetic gateway probe failed: ${String(error)}; requests=${JSON.stringify(capturedBodies)}`
            )
          })
        expect(calls).toBe(tool || custom || shell || patch ? 2 : 1)
        const started = (await journal.load()).filter(
          (record) => record.payload.type === "request_started"
        )
        expect(started).toHaveLength(tool || custom || shell || patch ? 2 : 1)
        for (const record of started) {
          if (record.payload.type !== "request_started") throw new Error("missing request receipt")
          expect(record.payload.request.requestId).toMatch(/^[a-f0-9]{32}:[1-9][0-9]*$/)
          expect(await service.inspectRequest(record.payload.request.requestId)).toMatchObject({
            scanId: "scan-fixture-1",
            outcome: authorityLost ? "UNKNOWN" : "SUCCEEDED",
            physicalOutstanding: authorityLost,
            usage: authorityLost ? null : { inputTokens: 8, outputTokens: 2 },
          })
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await journal.close()
        await rm(root, { recursive: true, force: true })
      }
    },
    40_000
  )
})
