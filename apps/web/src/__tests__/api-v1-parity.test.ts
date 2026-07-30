import { describe, it, expect } from "vitest"

// Each v1 route must re-export the same HTTP method handlers as its unversioned twin.

describe("/api/v1 parity", () => {
  it("scans (GET, POST)", async () => {
    const v1 = await import("../app/api/v1/scans/route")
    const twin = await import("../app/api/scans/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.POST).toBe(twin.POST)
  })

  it("scans/[id] (GET, POST)", async () => {
    const v1 = await import("../app/api/v1/scans/[id]/route")
    const twin = await import("../app/api/scans/[id]/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.POST).toBe(twin.POST)
  })

  it("findings (GET)", async () => {
    const v1 = await import("../app/api/v1/findings/route")
    const twin = await import("../app/api/findings/route")
    expect(v1.GET).toBe(twin.GET)
  })

  it("findings/[id] (GET, PATCH)", async () => {
    const v1 = await import("../app/api/v1/findings/[id]/route")
    const twin = await import("../app/api/findings/[id]/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.PATCH).toBe(twin.PATCH)
  })

  it("findings/[id]/fix-proposals (POST)", async () => {
    const v1 = await import("../app/api/v1/findings/[id]/fix-proposals/route")
    const twin = await import("../app/api/findings/[id]/fix-proposals/route")
    expect(v1.POST).toBe(twin.POST)
  })

  it("findings/[id]/retests (POST)", async () => {
    const v1 = await import("../app/api/v1/findings/[id]/retests/route")
    const twin = await import("../app/api/findings/[id]/retests/route")
    expect(v1.POST).toBe(twin.POST)
  })

  it("targets (GET, POST)", async () => {
    const v1 = await import("../app/api/v1/targets/route")
    const twin = await import("../app/api/targets/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.POST).toBe(twin.POST)
  })

  it("fix-proposals (GET)", async () => {
    const v1 = await import("../app/api/v1/fix-proposals/route")
    const twin = await import("../app/api/fix-proposals/route")
    expect(v1.GET).toBe(twin.GET)
  })

  it("fix-proposals/[id]/create-pr (POST)", async () => {
    const v1 = await import("../app/api/v1/fix-proposals/[id]/create-pr/route")
    const twin = await import("../app/api/fix-proposals/[id]/create-pr/route")
    expect(v1.POST).toBe(twin.POST)
  })

  it("retests (GET)", async () => {
    const v1 = await import("../app/api/v1/retests/route")
    const twin = await import("../app/api/retests/route")
    expect(v1.GET).toBe(twin.GET)
  })

  it("reports (GET, POST)", async () => {
    const v1 = await import("../app/api/v1/reports/route")
    const twin = await import("../app/api/reports/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.POST).toBe(twin.POST)
  })

  it("reports/[id] (GET, POST)", async () => {
    const v1 = await import("../app/api/v1/reports/[id]/route")
    const twin = await import("../app/api/reports/[id]/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.POST).toBe(twin.POST)
  })

  it("reports/[id]/download (GET)", async () => {
    const v1 = await import("../app/api/v1/reports/[id]/download/route")
    const twin = await import("../app/api/reports/[id]/download/route")
    expect(v1.GET).toBe(twin.GET)
  })

  it("launch-readiness (GET)", async () => {
    const v1 = await import("../app/api/v1/launch-readiness/route")
    const twin = await import("../app/api/launch-readiness/route")
    expect(v1.GET).toBe(twin.GET)
  })

  it("workspaces (GET, POST)", async () => {
    const v1 = await import("../app/api/v1/workspaces/route")
    const twin = await import("../app/api/workspaces/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.POST).toBe(twin.POST)
  })

  it("schedules (GET, POST)", async () => {
    const v1 = await import("../app/api/v1/schedules/route")
    const twin = await import("../app/api/schedules/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.POST).toBe(twin.POST)
  })

  it("schedules/[id] (GET, PATCH, DELETE)", async () => {
    const v1 = await import("../app/api/v1/schedules/[id]/route")
    const twin = await import("../app/api/schedules/[id]/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.PATCH).toBe(twin.PATCH)
    expect(v1.DELETE).toBe(twin.DELETE)
  })

  it("projects (GET, POST)", async () => {
    const v1 = await import("../app/api/v1/projects/route")
    const twin = await import("../app/api/projects/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.POST).toBe(twin.POST)
  })

  it("agent-approvals (GET, POST)", async () => {
    const v1 = await import("../app/api/v1/agent-approvals/route")
    const twin = await import("../app/api/agent-approvals/route")
    expect(v1.GET).toBe(twin.GET)
    expect(v1.POST).toBe(twin.POST)
  })

  it("agent-approvals/[id]/approve (POST)", async () => {
    const v1 = await import("../app/api/v1/agent-approvals/[id]/approve/route")
    const twin = await import("../app/api/agent-approvals/[id]/approve/route")
    expect(v1.POST).toBe(twin.POST)
  })

  it("agent-approvals/[id]/deny (POST)", async () => {
    const v1 = await import("../app/api/v1/agent-approvals/[id]/deny/route")
    const twin = await import("../app/api/agent-approvals/[id]/deny/route")
    expect(v1.POST).toBe(twin.POST)
  })
})
