import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

const packages = ["prisma", "@prisma/client", "@prisma/adapter-pg", "@prisma/client-runtime-utils"]

export function verifyPrismaVersions(manifest, installed, output) {
  const version = manifest.devDependencies?.prisma
  if (typeof version !== "string" || version.length > 100) {
    throw new Error("Prisma CLI must use an exact version")
  }
  const [base, ...prerelease] = version.split("-")
  if (
    !/^\d+\.\d+\.\d+$/.test(base) ||
    (prerelease.length && !/^[\w.-]+$/.test(prerelease.join("-")))
  ) {
    throw new Error("Prisma CLI must use an exact version")
  }
  for (const name of packages) {
    const declared = name === "prisma" ? version : manifest.dependencies?.[name]
    if (declared !== version || installed[name] !== version) {
      throw new Error(`${name} does not match Prisma ${version}`)
    }
  }
  for (const name of ["prisma", "@prisma/client"]) {
    const lines = output.split("\n").filter((entry) => entry.split(":")[0]?.trim() === name)
    if (lines.length !== 1 || lines[0].split(":")[1]?.trim() !== version) {
      throw new Error(`${name} reports an unexpected version`)
    }
  }
  return version
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Both paths are fixed to this checkout and the package names above.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const installed = Object.fromEntries(
    packages.map((name) => [
      name,
      JSON.parse(
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")
      ).version,
    ])
  )
  const output = execFileSync(
    "pnpm",
    ["--filter", "@lyrashield/db", "exec", "prisma", "--version"],
    {
      encoding: "utf8",
    }
  )
  console.log(`Prisma ${verifyPrismaVersions(manifest, installed, output)} verified`)
}
