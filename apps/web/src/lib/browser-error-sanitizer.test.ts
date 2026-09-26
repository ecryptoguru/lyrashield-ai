import { describe, expect, it } from "vitest"
import { sanitizeBrowserErrorEvent } from "./browser-error-sanitizer"

describe("sanitizeBrowserErrorEvent", () => {
  it("drops disabled and non-error events", () => {
    expect(sanitizeBrowserErrorEvent({} as never, false)).toBeNull()
    expect(sanitizeBrowserErrorEvent({ type: "transaction" } as never, true)).toBeNull()
  })

  it("keeps only bounded error facts and sanitized stack locations", () => {
    const sanitized = sanitizeBrowserErrorEvent(
      {
        event_id: "private-event-id",
        message: "user@example.com target https://private.test?token=secret",
        level: "warning",
        environment: "production",
        release: "lyrashield-ai+abc123",
        transaction: "GET /dashboard/scans/cmid123456789?target=https%3A%2F%2Fsecret.test",
        request: {
          url: "https://app.example.test/dashboard/scans/cmid123456789?token=secret",
          headers: { cookie: "session=secret" },
          data: { evidence: "private evidence" },
        },
        user: { id: "user-123", email: "user@example.com" },
        extra: { prompt: "private prompt" },
        contexts: { browser: { name: "private browser context" } },
        breadcrumbs: [{ message: "visited target", data: { url: "https://secret.test" } }],
        tags: { workspaceId: "workspace-secret" },
        exception: {
          values: [
            {
              type: "TypeError",
              value: "token=secret user@example.com",
              module: "private-module",
              mechanism: { data: { secret: "hidden" } },
              stacktrace: {
                frames: [
                  {
                    filename:
                      "webpack-internal:///apps/web/src/dashboard/scans/[id]/scan.tsx?secret=1",
                    function: "private function value",
                    lineno: 12,
                    colno: 4,
                    in_app: true,
                    vars: { token: "secret" },
                  },
                  { filename: "https://secret.test/key=secret", function: "hidden" },
                  { filename: "https://private-target.test/app.js", function: "hidden" },
                  { filename: "eval at secret", function: "not a source location" },
                ],
              },
            },
          ],
        },
      } as never,
      true
    )

    expect(sanitized).toEqual({
      level: "error",
      platform: "javascript",
      transaction: "/dashboard/scans/[id]",
      tags: { error_category: "TypeError" },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "TypeError",
            stacktrace: {
              frames: [{ filename: "scan.tsx", lineno: 12, colno: 4, in_app: true }],
            },
          },
        ],
      },
      environment: "production",
      release: "lyrashield-ai+abc123",
    })
    expect(JSON.stringify(sanitized)).not.toMatch(/user@example|secret|private|workspace-secret/)
  })

  it("collapses unknown route, error names, releases and environments", () => {
    const sanitized = sanitizeBrowserErrorEvent(
      {
        transaction: "/dashboard/private/this-is-a-private-record",
        environment: "private-environment",
        release: "release/contains/path",
        exception: { values: [{ type: "PrivateUserError", value: "secret" }] },
      } as never,
      true
    )
    expect(sanitized).toMatchObject({
      transaction: "/other",
      tags: { error_category: "Error" },
      exception: { values: [{ type: "Error", value: "Error" }] },
    })
    expect(sanitized).not.toHaveProperty("environment")
    expect(sanitized).not.toHaveProperty("release")
    expect(JSON.stringify(sanitized)).not.toContain("this-is-a-private-record")
  })
})
