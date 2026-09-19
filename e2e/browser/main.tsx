import { createRoot } from "react-dom/client"
import { SupportInbox } from "../../apps/web/src/app/(dashboard)/dashboard/admin/support/support-inbox-client"

import "../../apps/web/src/app/globals.css"

const root = createRoot(document.getElementById("root")!)
root.render(<SupportInbox />)
// Unmount through React so tests exercise effect cleanup, not document disposal.
window.addEventListener("test:unmount", () => root.unmount())
