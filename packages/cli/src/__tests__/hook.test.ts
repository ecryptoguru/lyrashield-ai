import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir as osTmpdir } from "node:os"
import path from "node:path"
import { handleHook } from "../commands/hook.js"
import type { Output } from "../output.js"

const tempDirectory = async () => realpath(osTmpdir())

let repo: string
const originalCwd = process.cwd()

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

async function initRepo(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  git(directory, "init", "--quiet")
}

function makeOutput(): Output {
  return {
    json: false,
    quiet: false,
    log: vi.fn(),
    notice: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    result: vi.fn(),
    fail: vi.fn() as unknown as (error: string, exitCode?: number) => never,
  }
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(await tempDirectory(), "lyrashield-hook-"))
  await initRepo(repo)
  process.chdir(repo)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(repo, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe("handleHook", () => {
  it("installs an executable advisory hook that uses only a local CLI on PATH", async () => {
    const output = makeOutput()

    await expect(handleHook(["install"], output)).resolves.toBe(0)
    const hookPath = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
    const hookFile = path.join(hookPath, "pre-commit")
    const hook = await readFile(hookFile, "utf8")
    expect(hook).toContain("#!/bin/sh")
    expect(hook).toContain("lyrashield check-diff --staged")
    expect(hook).toContain("CLI not found on PATH")
    expect(hook).not.toContain("npx")
    expect((await stat(hookFile)).mode & 0o111).toBeTruthy()

    const bin = path.join(repo, "bin")
    const calls = path.join(repo, "calls.txt")
    await mkdir(bin)
    await writeFile(
      path.join(bin, "lyrashield"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CALLS"\nexit 1\n',
      { mode: 0o755 }
    )
    const executed = spawnSync(hookFile, [], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, CALLS: calls, PATH: bin },
    })
    expect(executed.status).toBe(0)
    expect(executed.stdout + executed.stderr).toContain("allowing this commit")
    expect(await readFile(calls, "utf8")).toBe("check-diff --staged\n")

    const skipped = spawnSync(hookFile, [], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    })
    expect(skipped.status).toBe(0)
    expect(skipped.stdout + skipped.stderr).toContain("CLI not found on PATH")
  })

  it("is idempotent on reinstall and does not alter the hook mode", async () => {
    const output = makeOutput()
    await expect(handleHook(["install"], output)).resolves.toBe(0)
    const hookFile = path.join(
      git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks"),
      "pre-commit"
    )
    const before = await readFile(hookFile)
    const modeBefore = (await stat(hookFile)).mode & 0o777

    await expect(handleHook(["install"], output)).resolves.toBe(0)

    expect(await readFile(hookFile)).toEqual(before)
    expect((await stat(hookFile)).mode & 0o777).toBe(modeBefore)
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining("already installed"))
  })

  it("keeps concurrent installs from overwriting the user hook or duplicating the block", async () => {
    const hooksDirectory = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
    const hookFile = path.join(hooksDirectory, "pre-commit")
    const original = "#!/bin/sh\n# user's existing hook\necho keep-this\n"
    await writeFile(hookFile, original, { mode: 0o755 })

    const results = await Promise.all([
      handleHook(["install"], makeOutput()),
      handleHook(["install"], makeOutput()),
    ])

    expect(results).toEqual([0, 0])
    const installed = await readFile(hookFile, "utf8")
    expect(installed.startsWith(original)).toBe(true)
    expect(installed.match(/^# >>> LYRASHIELD managed pre-commit v1/gm)).toHaveLength(1)
    expect(installed).toContain("echo keep-this")
  })

  it("removes a newly created owned-only hook", async () => {
    const output = makeOutput()
    await handleHook(["install"], output)
    const hookFile = path.join(
      git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks"),
      "pre-commit"
    )

    await expect(handleHook(["remove"], output)).resolves.toBe(0)
    await expect(readFile(hookFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves existing commands, comments, CRLF, and mode across install and remove", async () => {
    const hooksDirectory = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
    const hookFile = path.join(hooksDirectory, "pre-commit")
    const original = Buffer.from("#!/bin/sh\r\n# user comment\r\necho user-command", "utf8")
    await writeFile(hookFile, original, { mode: 0o700 })
    await chmod(hookFile, 0o750)
    const output = makeOutput()

    await expect(handleHook(["install"], output)).resolves.toBe(0)
    const installed = await readFile(hookFile, "utf8")
    expect(installed).toContain("#!/bin/sh\r\n# user comment\r\necho user-command\r\n")
    expect(installed).toContain("eol=crlf")
    expect((await stat(hookFile)).mode & 0o777).toBe(0o750)

    await expect(handleHook(["remove"], output)).resolves.toBe(0)
    expect(await readFile(hookFile)).toEqual(original)
    expect((await stat(hookFile)).mode & 0o777).toBe(0o750)
  })

  it("resolves the common hooks path from a linked worktree", async () => {
    git(repo, "config", "user.email", "hook-test@example.invalid")
    git(repo, "config", "user.name", "LyraShield Hook Test")
    await writeFile(path.join(repo, "tracked.txt"), "worktree\n")
    git(repo, "add", "tracked.txt")
    git(repo, "commit", "--quiet", "-m", "initial")
    const linked = path.join(repo, "linked worktree")
    git(repo, "worktree", "add", "--quiet", "-b", "hook-test", linked)
    process.chdir(linked)
    const expectedHooks = git(linked, "rev-parse", "--path-format=absolute", "--git-path", "hooks")

    await expect(handleHook(["install"], makeOutput())).resolves.toBe(0)

    expect(await readFile(path.join(expectedHooks, "pre-commit"), "utf8")).toContain(
      "LYRASHIELD managed pre-commit"
    )
  })

  it("honors a relative custom core.hooksPath, including paths with spaces", async () => {
    git(repo, "config", "core.hooksPath", "custom hooks")
    const expectedHooks = path.join(repo, "custom hooks")

    await expect(handleHook(["install"], makeOutput())).resolves.toBe(0)

    expect(await readFile(path.join(expectedHooks, "pre-commit"), "utf8")).toContain(
      "LYRASHIELD managed pre-commit"
    )
    const defaultHooks = path.join(repo, ".git", "hooks", "pre-commit")
    await expect(readFile(defaultHooks)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([
    ["Python", "#!/usr/bin/env python3\nprint('keep me')\n"],
    ["Node", "#!/usr/bin/env node\nconsole.log('keep me')\n"],
  ])("refuses a %s hook without changing its bytes", async (_name, contents) => {
    const hooksDirectory = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
    const hookFile = path.join(hooksDirectory, "pre-commit")
    const original = Buffer.from(contents, "utf8")
    await writeFile(hookFile, original, { mode: 0o755 })
    const output = makeOutput()

    await expect(handleHook(["install"], output)).resolves.toBe(2)

    expect(output.error).toHaveBeenCalledWith(expect.stringMatching(/POSIX shell/i))
    expect(await readFile(hookFile)).toEqual(original)
  })

  it("preserves a non-executable hook mode and clearly reports that Git will skip it", async () => {
    const hooksDirectory = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
    const hookFile = path.join(hooksDirectory, "pre-commit")
    await writeFile(hookFile, "#!/bin/sh\necho user-hook\n", { mode: 0o644 })
    await chmod(hookFile, 0o644)
    const output = makeOutput()

    await expect(handleHook(["install"], output)).resolves.toBe(0)

    expect((await stat(hookFile)).mode & 0o777).toBe(0o644)
    expect(output.warn).toHaveBeenCalledWith(
      expect.stringMatching(/not executable, so Git will not run it/i)
    )
  })

  it.each([
    [
      "LF",
      "#!/bin/sh\n# LyraShield pre-commit hook — advisory check\nnpx -y lyrashield check-diff --staged || true\n",
    ],
    [
      "CRLF",
      "#!/bin/sh\r\n# LyraShield pre-commit hook — advisory check\r\nnpx -y lyrashield check-diff --staged || true\r\n",
    ],
  ])(
    "migrates the exact legacy %s hook to the local offline advisory block",
    async (_name, legacy) => {
      const hooksDirectory = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
      const hookFile = path.join(hooksDirectory, "pre-commit")
      await writeFile(hookFile, legacy, { mode: 0o750 })
      await chmod(hookFile, 0o750)
      const output = makeOutput()

      await expect(handleHook(["install"], output)).resolves.toBe(0)

      const installed = await readFile(hookFile, "utf8")
      expect(installed).not.toContain("npx")
      expect(installed).toContain("lyrashield check-diff --staged")
      expect(installed).toContain("eol=" + (_name === "CRLF" ? "crlf" : "lf"))
      expect(installed.match(/^# >>> LYRASHIELD managed pre-commit v1/gm)).toHaveLength(1)
      expect((await stat(hookFile)).mode & 0o777).toBe(0o750)
      expect(output.log).toHaveBeenCalledWith(
        expect.stringContaining("recognized legacy network hook")
      )
    }
  )

  it("refuses customized legacy hooks without removing user content or the old command", async () => {
    const hooksDirectory = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
    const hookFile = path.join(hooksDirectory, "pre-commit")
    const original = Buffer.from(
      "#!/bin/sh\n# user setup\n# LyraShield pre-commit hook — advisory check\nnpx -y lyrashield check-diff --staged || true\necho user's other check\n",
      "utf8"
    )
    await writeFile(hookFile, original, { mode: 0o755 })
    const output = makeOutput()

    await expect(handleHook(["install"], output)).resolves.toBe(2)

    expect(output.error).toHaveBeenCalledWith(
      expect.stringMatching(/Remove only the old LyraShield/i)
    )
    expect(await readFile(hookFile)).toEqual(original)
  })

  it("refuses a symlinked hook without changing its target", async () => {
    const hooksDirectory = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
    const hookFile = path.join(hooksDirectory, "pre-commit")
    const victim = path.join(repo, "user-hook.sh")
    await writeFile(victim, "#!/bin/sh\necho preserve-me\n", { mode: 0o755 })
    await symlink(victim, hookFile)
    const output = makeOutput()

    await expect(handleHook(["install"], output)).resolves.toBe(2)

    expect(output.error).toHaveBeenCalledWith(expect.stringMatching(/symlink/i))
    expect(await readFile(victim, "utf8")).toBe("#!/bin/sh\necho preserve-me\n")
  })

  it("refuses a custom hooks path reached through a symlink", async () => {
    const actualHooks = path.join(repo, "actual-hooks")
    const linkedHooks = path.join(repo, "linked-hooks")
    await mkdir(actualHooks)
    await symlink(actualHooks, linkedHooks)
    git(repo, "config", "core.hooksPath", linkedHooks)
    const output = makeOutput()

    await expect(handleHook(["install"], output)).resolves.toBe(2)

    expect(output.error).toHaveBeenCalledWith(expect.stringMatching(/symlink/i))
    await expect(readFile(path.join(actualHooks, "pre-commit"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("refuses to rewrite a modified LyraShield block", async () => {
    const hooksDirectory = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
    const hookFile = path.join(hooksDirectory, "pre-commit")
    const modified =
      "#!/bin/sh\n" +
      "# >>> LYRASHIELD managed pre-commit v1; created=0; shebang=0; separator=0; eol=lf >>>\n" +
      "custom content\n" +
      "# <<< LYRASHIELD managed pre-commit v1 <<<\n"
    await writeFile(hookFile, modified, { mode: 0o755 })
    const before = await readFile(hookFile)
    const output = makeOutput()

    await expect(handleHook(["remove"], output)).resolves.toBe(2)

    expect(output.error).toHaveBeenCalledWith(expect.stringMatching(/edited/i))
    expect(await readFile(hookFile)).toEqual(before)
  })
})
