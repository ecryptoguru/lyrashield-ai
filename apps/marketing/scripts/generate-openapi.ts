/* eslint-disable security/detect-non-literal-fs-filename */
import { buildOpenApiSpec } from "@lyrashield/types/openapi"
import { mkdirSync, writeFileSync } from "node:fs"

const spec = buildOpenApiSpec()
const content = JSON.stringify(spec, null, 2)

writeFileSync(new URL("../public/openapi.json", import.meta.url), content)

const dataDir = new URL("../src/data/", import.meta.url)
mkdirSync(dataDir, { recursive: true })
writeFileSync(new URL("./openapi.json", dataDir), content)
console.log("wrote openapi.json")
