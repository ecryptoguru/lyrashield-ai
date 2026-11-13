import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))

describe("Desktop developer workflow", () => {
  it("runs Tauri without scheduling its frontend Vite server a second time", () => {
    const plan = JSON.parse(
      execFileSync("pnpm", ["dev", "--dry=json"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      })
    ) as { tasks: Array<{ package: string; command: string }> }

    expect(
      plan.tasks.some(
        (task) => task.package === "@lyrashield/desktop" && task.command === "tauri dev"
      )
    ).toBe(true)
    expect(plan.tasks.some((task) => task.package === "@lyrashield/desktop-frontend")).toBe(false)
  })

  it("documents the Tauri build script that the Desktop package actually exposes", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8")
    ) as { scripts: Record<string, string> }
    const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8")

    expect(packageJson.scripts["tauri:build"]).toBe("tauri build")
    expect(readme).toMatch(/# Build the Tauri app[\s\S]*?cd apps\/desktop\s+pnpm tauri:build/)
  })
})
