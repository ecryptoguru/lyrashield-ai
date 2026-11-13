import { strict as assert } from "node:assert"
import { test } from "node:test"
import { verifyPrismaVersions } from "../verify-prisma-version.mjs"

const names = ["@prisma/client", "@prisma/adapter-pg", "@prisma/client-runtime-utils"]
const version = "8.1.2"
const manifest = {
  devDependencies: { prisma: version },
  dependencies: Object.fromEntries(names.map((name) => [name, version])),
}
const installed = { prisma: version, ...manifest.dependencies }
const output = `prisma : ${version}\n@prisma/client : ${version}\n`

test("accepts matching exact versions, including a newer major", () => {
  assert.equal(verifyPrismaVersions(manifest, installed, output), version)
})

test("rejects mismatched installed, declared and CLI versions", () => {
  assert.throws(() => verifyPrismaVersions(manifest, { ...installed, prisma: "8.1.1" }, output))
  assert.throws(() => verifyPrismaVersions(manifest, installed, output.replace(version, "8.1.1")))
  assert.throws(() => verifyPrismaVersions(manifest, installed, `${output}prisma: 8.1.1\n`))
  assert.throws(() =>
    verifyPrismaVersions(
      { ...manifest, dependencies: { ...manifest.dependencies, [names[0]]: "8.1.1" } },
      installed,
      output
    )
  )
  assert.throws(() =>
    verifyPrismaVersions({ ...manifest, devDependencies: { prisma: "^8.1.2" } }, installed, output)
  )
})
