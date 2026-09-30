import { createRoot } from "react-dom/client"
import PollingHarness from "./polling-harness"
import "../../apps/web/src/app/globals.css"

const root = createRoot(document.getElementById("root")!)
root.render(<PollingHarness />)
window.addEventListener("test:unmount", () => root.unmount())
