import { describe, expect, it } from "vitest"
import { authorizeRequest, type RequestPolicy } from "./request-policy"
import { fixturePolicy } from "./test-fixtures"

const policy: RequestPolicy = {
  ...fixturePolicy,
  adapter: "responses-agent-v1",
  maxInputTokens: 8_192,
  maxOutputTokens: 128,
}

// Captured from the pinned engine's OpenAI Agents SDK during a synthetic tool turn.
const engineRequest = {
  model: "gpt-6-luna",
  input: [
    { role: "user", content: "inspect synthetic data" },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "lookup",
      arguments: '{"name":"test"}',
      status: "completed",
    },
    { type: "function_call_output", call_id: "call_1", output: "test" },
  ],
  instructions: "Review synthetic input.",
  max_output_tokens: 128,
  parallel_tool_calls: false,
  reasoning: { effort: "medium" },
  include: [],
  tools: [
    {
      type: "function",
      name: "lookup",
      description: "Return a synthetic value.",
      parameters: {
        additionalProperties: false,
        properties: { name: { title: "Name", type: "string" } },
        required: ["name"],
        title: "lookup_args",
        type: "object",
      },
      strict: true,
    },
  ],
}

function check(body: Buffer, selectedPolicy = policy) {
  return authorizeRequest(selectedPolicy, {
    path: selectedPolicy.endpoint,
    method: "POST",
    contentType: "application/json",
    body,
  })
}

describe("bounded provider agent requests", () => {
  it("accepts the real SDK's text, function call, tool result and reasoning shape", () => {
    expect(check(Buffer.from(JSON.stringify(engineRequest)))).toMatchObject({
      model: "gpt-6-luna",
      maxOutputTokens: 128,
      stream: false,
      reservationMicros: expect.any(Number),
    })
  })

  it("keeps the existing text policy closed to agent tools", () => {
    expect(() => check(Buffer.from(JSON.stringify(engineRequest)), fixturePolicy)).toThrow(
      /shape is not approved/
    )
  })

  it("accepts local non-strict tool schemas used by the engine", () => {
    const request = { ...engineRequest, tools: [{ ...engineRequest.tools[0], strict: false }] }
    expect(check(Buffer.from(JSON.stringify(request)))).toMatchObject({ model: "gpt-6-luna" })
  })

  it("accepts a local structured response schema", () => {
    const request = {
      ...engineRequest,
      text: {
        format: {
          type: "json_schema",
          name: "DedupeJudgement",
          schema: { type: "object", properties: { is_duplicate: { type: "boolean" } } },
          strict: true,
        },
      },
    }
    expect(check(Buffer.from(JSON.stringify(request)))).toMatchObject({ model: "gpt-6-luna" })
  })

  it("accepts native local custom-tool calls and results", () => {
    const request = {
      ...engineRequest,
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "read_file",
          input: "synthetic",
          caller: { type: "direct" },
        },
        { type: "custom_tool_call_output", call_id: "call_1", output: "content" },
      ],
      tools: [{ type: "custom", name: "read_file", description: "Read a local file" }],
    }
    expect(check(Buffer.from(JSON.stringify(request)))).toMatchObject({ model: "gpt-6-luna" })
  })

  it("accepts local shell calls while excluding hosted shell environments", () => {
    const request = {
      ...engineRequest,
      input: [
        {
          type: "shell_call",
          id: "fc_1",
          call_id: "call_1",
          status: "completed",
          action: { commands: ["echo synthetic"] },
        },
        {
          type: "shell_call_output",
          call_id: "call_1",
          output: [{ stdout: "synthetic", stderr: "", outcome: { type: "exit", exit_code: 0 } }],
        },
      ],
      tools: [{ type: "shell", environment: { type: "local" } }],
    }
    expect(check(Buffer.from(JSON.stringify(request)))).toMatchObject({ model: "gpt-6-luna" })
  })

  it("accepts local patch calls and their results", () => {
    const request = {
      ...engineRequest,
      input: [
        {
          type: "apply_patch_call",
          id: "fc_1",
          call_id: "call_1",
          status: "completed",
          operation: { type: "create_file", path: "synthetic.txt", diff: "+synthetic" },
        },
        {
          type: "apply_patch_call_output",
          call_id: "call_1",
          status: "completed",
          output: "synthetic",
        },
      ],
      tools: [{ type: "apply_patch" }],
    }
    expect(check(Buffer.from(JSON.stringify(request)))).toMatchObject({ model: "gpt-6-luna" })
  })

  it.each([
    { ...engineRequest, tools: [{ type: "web_search" }] },
    {
      ...engineRequest,
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "read_file",
          input: "synthetic",
          caller: { type: "program", caller_id: "remote" },
        },
      ],
    },
    { ...engineRequest, tools: [{ type: "shell", environment: { type: "container_auto" } }] },
    {
      ...engineRequest,
      tools: [{ type: "custom", name: "read_file", endpoint: "https://example.test" }],
    },
    { ...engineRequest, previous_response_id: "provider-side-state" },
    {
      ...engineRequest,
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.test/image" }],
        },
      ],
    },
    {
      ...engineRequest,
      tools: [
        {
          ...engineRequest.tools[0],
          parameters: { type: "object", $ref: "https://example.test/schema" },
        },
      ],
    },
    {
      ...engineRequest,
      text: {
        format: {
          type: "json_schema",
          name: "result",
          schema: { type: "object", $ref: "https://example.test/schema" },
          strict: true,
        },
      },
    },
  ])("rejects provider-side tools, remote acquisition and unsupported state", (request) => {
    expect(() => check(Buffer.from(JSON.stringify(request)))).toThrow(/shape is not approved/)
  })

  it("rejects duplicate members even when their escaped spellings match", () => {
    for (const raw of [
      '{"model":"not-approved","model":"gpt-6-luna","input":"x","max_output_tokens":1}',
      '{"model":"gpt-6-luna","input":"x","max_output_tokens":1,"tools":[{"type":"web_search","ty\\u0070e":"function"}]}',
    ])
      expect(() => check(Buffer.from(raw))).toThrow(/invalid/)
  })

  it("bounds all prompt, tool and message bytes before reserving provider cost", () => {
    const request = { ...engineRequest, instructions: "x".repeat(8_192) }
    expect(() => check(Buffer.from(JSON.stringify(request)))).toThrow(/token policy/)
    expect(() =>
      check(Buffer.from(JSON.stringify({ ...engineRequest, max_output_tokens: 129 })))
    ).toThrow(/token policy/)
  })

  it("rejects deeply nested input before validating tool schemas", () => {
    let schema: Record<string, unknown> = { type: "string" }
    for (let index = 0; index < 70; index += 1) schema = { properties: { child: schema } }
    const request = {
      ...engineRequest,
      tools: [{ ...engineRequest.tools[0], parameters: { type: "object", ...schema } }],
    }
    expect(() => check(Buffer.from(JSON.stringify(request)))).toThrow(/invalid/)
  })
})
