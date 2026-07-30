import { writeFile, access, chmod } from "node:fs/promises"
import path from "node:path"
import type { Output } from "../output.js"

const HOOK = `#!/bin/sh
# LyraShield pre-commit hook — advisory check
npx -y lyrashield check-diff --staged || true
`

export async function handleHook(args: string[], output: Output): Promise<number> {
  const [sub] = args
  if (sub !== "install") {
    output.error("usage: lyrashield hook install")
    return 2
  }
  const gitDir = path.join(process.cwd(), ".git")
  try {
    await access(gitDir)
  } catch {
    output.error("Not a git repository.")
    return 2
  }
  const hookPath = path.join(gitDir, "hooks", "pre-commit")
  try {
    await access(hookPath)
    output.error(`pre-commit hook already exists at ${hookPath}. Merge manually.`)
    return 2
  } catch {
    // safe to write
  }
  await writeFile(hookPath, HOOK, { mode: 0o755 })
  await chmod(hookPath, 0o755)
  output.log(`Installed pre-commit hook at ${hookPath}`)
  return 0
}
