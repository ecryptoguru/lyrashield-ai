import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, expect, it, vi } from "vitest"
import { createSandboxToolPtyHandler } from "./sandbox-tool-pty"
import type { createSandboxToolRunner } from "./sandbox-tool-runner"

const binding = {
  attemptId: "attempt-1",
  operationId: "operation-1",
  authorityEpochId: "epoch-1",
  sandboxHandle: "sandbox-1",
}
const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
const token = "t".repeat(48)
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

async function fixture() {
  const operations = {
    executePty: vi.fn().mockResolvedValue({ sessionId: 12 }),
    executeMutation: vi.fn().mockResolvedValue({ status: "COMPLETED" }),
    readPty: vi.fn().mockResolvedValue({ sessionId: 12 }),
  }
  const run = vi.fn(async (_credential, effect) => effect(binding))
  const handler = createSandboxToolPtyHandler(
    { authority: { run }, operations } as unknown as ReturnType<typeof createSandboxToolRunner>,
    async (_request, response) => {
      response.writeHead(404).end()
    }
  )
  const server = createServer((request, response) => {
    void handler(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sandbox/attempt-1/pty/`
  const headers = {
    authorization: `Bearer ${token}`,
    "x-lyrashield-sandbox-handle": binding.sandboxHandle,
    "content-type": "application/json",
  }
  return { url, headers, operations, run }
}
const base = { binding, requestId, commandId: "command-1" }

it("routes bounded PTY starts through the existing scoped runner", async () => {
  const f = await fixture()
  const input = {
    ...base,
    argv: ["/usr/bin/true"],
    cwd: "/workspace",
    user: "pentester",
    timeoutSeconds: 2,
    maxOutputBytes: 1024,
    tty: true,
    yieldTimeSeconds: 0,
    maxOutputTokens: 100,
  }
  const response = await fetch(f.url + "start", {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify(input),
  })
  expect(response.status).toBe(200)
  expect(f.operations.executePty).toHaveBeenCalledWith(
    { token, attemptId: binding.attemptId, sandboxHandle: binding.sandboxHandle },
    {
      ...base,
      argv: input.argv,
      cwd: input.cwd,
      user: input.user,
      timeoutSeconds: 2,
      maxOutputBytes: 1024,
    },
    { tty: true, yieldTimeSeconds: 0, maxOutputTokens: 100 }
  )
})

it("keeps ordinary PTY termination separate from scoped sandbox stop", async () => {
  const f = await fixture()
  expect(
    (
      await fetch(f.url + "terminate", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify(base),
      })
    ).status
  ).toBe(200)
  expect(f.operations.executeMutation.mock.calls[0]?.slice(2)).toEqual(["pty/terminate", {}])
  expect(
    (
      await fetch(f.url + "terminate", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ ...base, stopSandbox: true }),
      })
    ).status
  ).toBe(503)
  expect(f.operations.executeMutation).toHaveBeenCalledTimes(1)
})

it("rejects missing credentials, foreign bindings and excessive stdin before effects", async () => {
  const f = await fixture()
  const input = {
    ...base,
    sessionId: 12,
    chars: "input",
    outputCursor: 0,
    yieldTimeSeconds: 0,
    maxOutputTokens: 100,
  }
  expect(
    (await fetch(f.url + "stdin", { method: "POST", body: JSON.stringify(input) })).status
  ).toBe(401)
  for (const changed of [
    { ...input, binding: { ...binding, attemptId: "foreign-attempt" } },
    { ...input, chars: "x".repeat(65537) },
  ]) {
    expect(
      (
        await fetch(f.url + "stdin", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify(changed),
        })
      ).status
    ).toBe(503)
  }
  expect(f.operations.executeMutation).not.toHaveBeenCalled()
})

it("requires a unique bounded cursor and yield query for reads", async () => {
  const f = await fixture()
  expect(
    (
      await fetch(f.url + "12?outputCursor=0&yieldTimeSeconds=0&maxOutputTokens=100", {
        headers: f.headers,
      })
    ).status
  ).toBe(200)
  expect(f.operations.readPty).toHaveBeenCalledWith(expect.anything(), {
    sessionId: 12,
    outputCursor: 0,
    maxOutputBytes: 400,
    yieldTimeSeconds: 0,
  })
  expect(
    (
      await fetch(
        f.url + "12?outputCursor=0&yieldTimeSeconds=0&maxOutputTokens=100&outputCursor=1",
        { headers: f.headers }
      )
    ).status
  ).toBe(503)
  expect(
    (
      await fetch(
        f.url + "9007199254740992?outputCursor=0&yieldTimeSeconds=0&maxOutputTokens=100",
        { headers: f.headers }
      )
    ).status
  ).toBe(503)
  expect(f.operations.readPty).toHaveBeenCalledTimes(1)
})
