import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => ({
  search: "",
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}))

vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  useSearchParams: () => new URLSearchParams(navigation.search),
}))

import { TooltipProvider } from "@/components/ui/tooltip"
import { TargetsClient } from "./targets-client"
import type { Target } from "./targets-model"

const existingTarget: Target = {
  id: "target-1",
  name: "Example",
  type: "WEB_APP",
  url: "https://example.test",
  apiSpecUrl: null,
  repoFullName: null,
  branch: null,
  environment: "STAGING",
  status: "ACTIVE",
  lastScanAt: null,
  project: null,
  scanCount: 0,
  findingCount: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
}

beforeEach(() => {
  navigation.search = ""
  navigation.router.push.mockReset()
  navigation.router.replace.mockReset()
  navigation.router.refresh.mockReset()
})

function renderTargets(search = "", initialData: Target[] = []) {
  navigation.search = search
  return renderToStaticMarkup(
    <TargetsClient workspaceId="workspace-1" initialData={initialData} initialNextCursor={null} />
  )
}

it("shows one add-target action when the workspace has no targets", () => {
  const html = renderTargets()

  expect(html).toContain("No targets yet")
  expect(html).toContain("Add target")
  expect(html).not.toContain("New Target")
  expect(html.match(/Add target/g)).toHaveLength(1)
})

it("opens the target form for the direct add-target URL", () => {
  const html = renderTargets("add=1")

  expect(html).toContain('id="repo-name-input"')
  expect(html).toContain('id="repo-owner"')
  expect(html).not.toContain("No targets yet")
})

it("uses the same add-target wording once targets already exist", () => {
  const html = renderTargets("", [existingTarget])

  expect(html).toContain("Add target")
  expect(html).not.toContain("New Target")
})

it("starts source setup inline without the target management page", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <TargetsClient scanSetup workspaceId="workspace-1" initialData={[]} />
    </TooltipProvider>
  )
  expect(html).toContain("Configure a scan")
  expect(html).toContain("Continue to scan setup")
  expect(html).toContain('id="url-input"')
  expect(html).not.toContain("No targets yet")
  expect(html).not.toContain("Create Target")
})
