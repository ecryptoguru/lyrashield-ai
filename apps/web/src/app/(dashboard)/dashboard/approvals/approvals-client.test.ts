import { describe, expect, it } from "vitest"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ApprovalsClient } from "./approvals-client"
import type { ApprovalListItem } from "@lyrashield/db"

// The repository's JSX-preserve compiler uses the classic runtime in Vitest.
Object.assign(globalThis, { React })
describe("approval input disclosure", () => {
  it("renders all input keys and nested values as escaped text with an explicit confirmation", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalsClient, {
        workspaceId: "ws-1",
        hasProposals: false,
        approvals: [
          {
            id: "approval-1",
            actionName: "fix_pr.open",
            input: {
              title: '<img src=x onerror="alert(1)">',
              nested: { diff: "<script>bad()</script>" },
              enabled: false,
            },
            expiresAt: null,
          } as unknown as ApprovalListItem,
        ],
      })
    )
    expect(html).toContain("Review exact action input")
    expect(html).toContain("nested")
    expect(html).toContain("enabled")
    expect(html).toContain("false")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain(">Approve</button>")
    expect(html).not.toContain(">Approve action</button>")
  })
})
