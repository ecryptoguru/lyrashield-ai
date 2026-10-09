import { createRoot } from "react-dom/client"

const root = createRoot(document.getElementById("root")!)
if (new URLSearchParams(location.search).has("forms")) {
  await import("../../apps/web/src/app/globals.css")
  const { default: FormsHarness } = await import("./forms-harness")
  root.render(<FormsHarness />)
} else if (new URLSearchParams(location.search).has("agents")) {
  await import("../../apps/web/src/app/globals.css")
  const { AgentsHarness } = await import("./agents-harness")
  root.render(<AgentsHarness />)
} else if (new URLSearchParams(location.search).has("agent-wizard")) {
  await import("../../apps/web/src/app/globals.css")
  const { AgentWizardHarness } = await import("./agents-harness")
  const agentId = new URLSearchParams(location.search).get("agent-wizard") ?? ""
  root.render(<AgentWizardHarness agentId={agentId} />)
} else if (new URLSearchParams(location.search).get("myra") === "marketing") {
  const { createMyraClient } = await import("../../packages/myra/src/client")
  const { renderMyraProposalActions } =
    await import("../../apps/marketing/src/components/myra/myra-dom-renderer")
  const card = document.createElement("section")
  document.getElementById("root")!.append(card)
  renderMyraProposalActions(
    card,
    {
      id: "proposal-1",
      title: "Myra proposal",
      description: "Review this action",
      confirmLabel: "Confirm action",
    },
    {
      client: createMyraClient({ apiBase: "", surface: "MARKETING" }),
      apiBase: "",
      announce: () => {},
      send: () => {},
      markActionCompleted: () => {},
      setLastTraceId: () => {},
    }
  )
} else if (new URLSearchParams(location.search).has("findings")) {
  await import("../../apps/web/src/app/globals.css")
  const { default: FindingsHarness } = await import("./findings-harness")
  root.render(<FindingsHarness />)
} else if (new URLSearchParams(location.search).has("onboarding")) {
  await import("../../apps/web/src/app/globals.css")
  const { default: OnboardingHarness } = await import("./onboarding-harness")
  root.render(<OnboardingHarness />)
} else if (new URLSearchParams(location.search).has("ux")) {
  await import("../../apps/web/src/app/globals.css")
  const { default: UxFocusHarness } = await import("./ux-focus-harness")
  root.render(<UxFocusHarness />)
} else if (
  location.pathname === "/dashboard/reports" ||
  new URLSearchParams(location.search).get("tab") === "reports"
) {
  await import("../../apps/web/src/app/globals.css")
  const { default: ReportsHarness } = await import("./reports-harness")
  root.render(<ReportsHarness />)
} else if (new URLSearchParams(location.search).has("desktop")) {
  await import("../../apps/desktop/frontend/src/styles/globals.css")
  const { default: DesktopHarness } = await import("./desktop-harness")
  root.render(<DesktopHarness />)
} else if (new URLSearchParams(location.search).has("myra")) {
  await import("../../apps/web/src/app/globals.css")
  const { default: MyraHarness } = await import("./myra-harness")
  root.render(<MyraHarness />)
} else {
  await import("../../apps/web/src/app/globals.css")
  const { SupportInbox } =
    await import("../../apps/web/src/app/(dashboard)/dashboard/admin/support/support-inbox-client")
  root.render(<SupportInbox />)
}
// Unmount through React so tests exercise effect cleanup, not document disposal.
window.addEventListener("test:unmount", () => root.unmount())
