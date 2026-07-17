import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const source = resolve(root, "renders/web")
const destination = resolve(root, "../marketing/public/media-local/assurance-world/v1/local")

if (!existsSync(source)) throw new Error("Run pnpm derive before preparing the local preview")

rmSync(destination, { recursive: true, force: true })
mkdirSync(destination, { recursive: true })
cpSync(source, destination, { recursive: true })
writeFileSync(
  resolve(destination, "manifest.json"),
  `${JSON.stringify({ version: "1", renderHash: "local", generatedBy: "@lyrashield/marketing-motion" }, null, 2)}\n`
)
console.log(`Local preview media prepared at ${destination}`)
