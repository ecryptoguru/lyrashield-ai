import path from "node:path"
import { fileURLToPath } from "node:url"

export { validatePlugin } from "./validate.js"
export { buildPlugin } from "./build.js"
export { exportMarketplace } from "./export.js"

export function getPluginDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(__dirname, "..", "plugin")
}
