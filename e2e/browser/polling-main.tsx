import { createRoot } from "react-dom/client"
import PollingHarness from "./polling-harness"
import "../../apps/web/src/app/globals.css"

createRoot(document.getElementById("root")!).render(<PollingHarness />)
