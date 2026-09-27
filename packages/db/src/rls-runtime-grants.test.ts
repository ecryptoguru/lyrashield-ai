import { describe, expect, it } from "vitest"
import ciWorkflow from "../../../.github/workflows/ci.yml?raw"

describe("CI restricted runtime-role contract", () => {
  it("grants runtime table and sequence access individually", () => {
    expect(ciWorkflow).not.toContain("ON ALL TABLES IN SCHEMA public TO app_runtime_ci")
    expect(ciWorkflow).not.toContain("ON ALL SEQUENCES IN SCHEMA public TO app_runtime_ci")
    expect(ciWorkflow).toContain("ON TABLE public.%I TO app_runtime_ci")
    expect(ciWorkflow).toContain("ON SEQUENCE public.%I TO app_runtime_ci")
    expect(ciWorkflow).toContain("PlatformAdminElevation")
    expect(ciWorkflow).toContain("PlatformAdminChallengeLimit")
    expect(ciWorkflow).toContain("PlatformAdminAudit")
  })

  it("runs a restricted-role read smoke for every workspace or account table", () => {
    expect(ciWorkflow).toContain("Smoke-test production-equivalent account and workspace grants")
    expect(ciWorkflow).toContain("c.column_name IN ('workspaceId', 'accountId')")
    expect(ciWorkflow).toContain("SELECT 1 FROM public.%I LIMIT 0")
  })
})
