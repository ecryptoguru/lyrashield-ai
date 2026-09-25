import { createRoot } from "react-dom/client"

const root = createRoot(document.getElementById("root")!)
if (new URLSearchParams(location.search).get("myra") === "marketing") {
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
