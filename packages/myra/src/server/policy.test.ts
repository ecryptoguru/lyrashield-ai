import "./test-env"
import { describe, expect, it } from "vitest"
import { allowedToolsFor, isToolAllowed } from "./policy"
import { classifyIntent } from "./loop"
import { hashOperationPayload } from "./operations"
import type { MyraPrincipal } from "../contracts"

const anon: MyraPrincipal = { kind: "anonymous", publicSessionId: "ps_1" }
const user: MyraPrincipal = {
  kind: "user",
  accountId: "u_1",
  sessionId: "s_1",
  workspaceId: null,
  role: null,
}
const operator: MyraPrincipal = { kind: "operator", accountId: "op_1", sessionId: "s_2" }

describe("capability policy", () => {
  it("anonymous gets the public set only", () => {
    expect(isToolAllowed(anon, "read_product_catalog")).toBe(true)
    expect(isToolAllowed(anon, "submit_support_case")).toBe(true)
    expect(isToolAllowed(anon, "get_my_context")).toBe(false)
    expect(isToolAllowed(anon, "read_memory")).toBe(false)
    expect(isToolAllowed(anon, "start_guided_flow")).toBe(false)
  })

  it("user gets public + account tools", () => {
    expect(isToolAllowed(user, "read_product_catalog")).toBe(true)
    expect(isToolAllowed(user, "get_my_context")).toBe(true)
    expect(isToolAllowed(user, "write_memory")).toBe(true)
    expect(isToolAllowed(user, "attach_trace")).toBe(true)
  })

  it("operator is not a chat principal", () => {
    expect(allowedToolsFor(operator).size).toBe(0)
  })
})

describe("classifyIntent", () => {
  it("routes deterministic intents", () => {
    expect(classifyIntent("how much does pro cost", false)).toBe("catalog")
    expect(classifyIntent("book a demo", false)).toBe("demo")
    expect(classifyIntent("can I talk to a person", false)).toBe("support_case")
    expect(classifyIntent("how many minutes left on my plan", true)).toBe("account")
    expect(classifyIntent("my scan won't start", true)).toBe("flow_start")
    expect(classifyIntent("my scan won't start", false)).toBe("help")
    expect(classifyIntent("what is an inconclusive result", true)).toBe("evidence")
  })
})

describe("hashOperationPayload", () => {
  it("is stable for identical payloads and differs on change", () => {
    const a = hashOperationPayload({ subject: "s", summary: "x" })
    expect(hashOperationPayload({ subject: "s", summary: "x" })).toBe(a)
    expect(hashOperationPayload({ subject: "s", summary: "y" })).not.toBe(a)
  })
})
