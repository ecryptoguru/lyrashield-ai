import { createRoot } from "react-dom/client"

const root = createRoot(document.getElementById("root")!)
if (new URLSearchParams(location.search).has("desktop")) {
  await import("../../apps/desktop/frontend/src/styles/globals.css")
  const { default: DesktopHarness } = await import("./desktop-harness")
  root.render(<DesktopHarness />)
} else {
  await import("../../apps/web/src/app/globals.css")
  const { SupportInbox } =
    await import("../../apps/web/src/app/(dashboard)/dashboard/admin/support/support-inbox-client")
  root.render(<SupportInbox />)
}
// Unmount through React so tests exercise effect cleanup, not document disposal.
window.addEventListener("test:unmount", () => root.unmount())
