/* eslint-disable security/detect-non-literal-fs-filename */
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { execFile as nodeExecFile } from "node:child_process"
import { link, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises"
import { promisify } from "node:util"
import path from "node:path"
import type { Output } from "../output.js"

const execFile = promisify(nodeExecFile)
const BEGIN_PREFIX = "# >>> LYRASHIELD managed pre-commit v1"
const END_MARKER = "# <<< LYRASHIELD managed pre-commit v1 <<<"
const LEGACY_HOOK_LF =
  "#!/bin/sh\n# LyraShield pre-commit hook — advisory check\nnpx -y lyrashield check-diff --staged || true\n"
const LEGACY_HOOK_COMMENT = "# LyraShield pre-commit hook — advisory check"
const LEGACY_HOOK_COMMAND = "npx -y lyrashield check-diff --staged || true"
const BEGIN_RE =
  /^# >>> LYRASHIELD managed pre-commit v1; created=(0|1); shebang=(0|1); separator=(0|1); eol=(lf|crlf) >>>$/

const OWNED_LINES = [
  "if command -v lyrashield >/dev/null 2>&1; then",
  "  if ! lyrashield check-diff --staged; then",
  "    printf '%s\\n' 'LyraShield advisory check did not pass; allowing this commit.' >&2",
  "  fi",
  "else",
  "  printf '%s\\n' 'LyraShield advisory check skipped: lyrashield CLI not found on PATH.' >&2",
  "fi",
]
const POSIX_SHELLS = new Set(["ash", "bash", "dash", "ksh", "mksh", "sh", "yash", "zsh"])

interface InstallResult {
  outcome: "installed" | "migrated" | "unchanged"
  executable: boolean
}

interface ManagedBlockMetadata {
  created: boolean
  shebangAdded: boolean
  separatorAdded: boolean
  eol: "\n" | "\r\n"
}

interface TextLine {
  content: string
  start: number
  contentEnd: number
  end: number
  eol: "" | "\n" | "\r\n"
}

interface ManagedBlock {
  metadata: ManagedBlockMetadata
  begin: TextLine
  end: TextLine
}

interface HookSnapshot {
  content: Buffer
  mode: number
  dev: number
  ino: number
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 })
  return result.stdout.replace(/\r?\n$/, "")
}

async function configuredHooksPath(root: string): Promise<string | undefined> {
  try {
    const configured = await gitOutput(["config", "--path", "--get", "core.hooksPath"], root)
    if (!configured || configured.includes("\n") || configured.includes("\r")) {
      throw new Error("Git returned an invalid core.hooksPath value.")
    }
    return path.isAbsolute(configured) ? configured : path.resolve(root, configured)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
      return undefined
    }
    throw error
  }
}

async function resolveHookPath(cwd: string): Promise<string> {
  let root: string
  try {
    root = await gitOutput(["rev-parse", "--show-toplevel"], cwd)
  } catch {
    throw new Error("Not a Git working tree. Run this command from inside a Git repository.")
  }
  if (!root || root.includes("\n") || root.includes("\r")) {
    throw new Error("Git returned an invalid working-tree path.")
  }

  // Git may canonicalize a configured symlink in its --git-path output. Check
  // the effective configured spelling too, so a redirected hooksPath is not
  // silently accepted just because Git resolved it for us.
  const configured = await configuredHooksPath(root)
  if (configured) await assertSafeDirectory(configured)

  let hooksDirectory: string
  try {
    hooksDirectory = await gitOutput(
      ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
      root
    )
  } catch {
    throw new Error("Git could not resolve its active hooks path.")
  }
  if (
    !hooksDirectory ||
    hooksDirectory.includes("\n") ||
    hooksDirectory.includes("\r") ||
    !path.isAbsolute(hooksDirectory)
  ) {
    throw new Error("Git returned an invalid hooks path.")
  }
  return path.join(path.resolve(hooksDirectory), "pre-commit")
}

async function assertSafeDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory)
  const filesystemRoot = path.parse(resolved).root
  if (!resolved || resolved === filesystemRoot) {
    throw new Error(`Refusing unsafe hooks directory: ${directory}`)
  }

  const relative = path.relative(filesystemRoot, resolved)
  let current = filesystemRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) return
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing hooks path through symlink: ${current}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`Refusing hooks path through non-directory: ${current}`)
    }
  }
}

async function ensureHooksDirectory(directory: string): Promise<void> {
  await assertSafeDirectory(directory)
  await mkdir(directory, { recursive: true, mode: 0o755 })
  await assertSafeDirectory(directory)
}

async function assertSafeHookPath(hookPath: string): Promise<void> {
  await assertSafeDirectory(path.dirname(hookPath))
  if (path.basename(hookPath) !== "pre-commit") {
    throw new Error(`Refusing unexpected Git hook path: ${hookPath}`)
  }
}

async function readHookSnapshot(hookPath: string): Promise<HookSnapshot | undefined> {
  const before = await lstat(hookPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!before) return undefined
  if (before.isSymbolicLink()) {
    throw new Error("Refusing symlinked pre-commit hook: " + hookPath)
  }
  if (!before.isFile()) {
    throw new Error(`Refusing unsafe pre-commit hook (expected a regular file): ${hookPath}`)
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    handle = await open(hookPath, flags)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`The pre-commit hook changed while it was being read: ${hookPath}`)
    }
    const content = await handle.readFile()
    const afterRead = await handle.stat()
    if (
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size ||
      afterRead.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error(`The pre-commit hook changed while it was being read: ${hookPath}`)
    }
    return {
      content,
      mode: opened.mode & 0o7777,
      dev: opened.dev,
      ino: opened.ino,
    }
  } catch (error) {
    if (isErrno(error, "ELOOP")) {
      throw new Error(`Refusing symlinked pre-commit hook: ${hookPath}`)
    }
    throw error
  } finally {
    await handle?.close()
  }
}

function sameSnapshot(left: HookSnapshot | undefined, right: HookSnapshot | undefined): boolean {
  if (!left || !right) return left === right
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.content.equals(right.content)
  )
}

function decodeHook(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content)
  } catch {
    throw new Error("The existing pre-commit hook is not valid UTF-8; refusing to rewrite it.")
  }
}

function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = []
  let start = 0
  while (start < text.length) {
    const newlineIndex = text.indexOf("\n", start)
    if (newlineIndex === -1) {
      lines.push({
        content: text.slice(start),
        start,
        contentEnd: text.length,
        end: text.length,
        eol: "",
      })
      break
    }
    const hasCarriageReturn = newlineIndex > start && text[newlineIndex - 1] === "\r"
    const contentEnd = hasCarriageReturn ? newlineIndex - 1 : newlineIndex
    const eol = hasCarriageReturn ? "\r\n" : "\n"
    lines.push({
      content: text.slice(start, contentEnd),
      start,
      contentEnd,
      end: newlineIndex + 1,
      eol,
    })
    start = newlineIndex + 1
  }
  return lines
}

function renderOwnedLines(metadata: ManagedBlockMetadata): string[] {
  const eolName = metadata.eol === "\r\n" ? "crlf" : "lf"
  const begin = `${BEGIN_PREFIX}; created=${metadata.created ? 1 : 0}; shebang=${metadata.shebangAdded ? 1 : 0}; separator=${metadata.separatorAdded ? 1 : 0}; eol=${eolName} >>>`
  return [begin, ...OWNED_LINES, END_MARKER]
}

function parseManagedBlock(text: string): ManagedBlock | undefined {
  const lines = splitLines(text)
  const beginCandidates = lines.filter((line) => line.content.startsWith(BEGIN_PREFIX))
  const endCandidates = lines.filter((line) => line.content.startsWith(END_MARKER))
  if (beginCandidates.length === 0 && endCandidates.length === 0) return undefined
  if (beginCandidates.length !== 1 || endCandidates.length !== 1) {
    throw new Error(
      "Found an ambiguous LyraShield hook marker; refusing to modify user hook content."
    )
  }

  const begin = beginCandidates[0]!
  const end = endCandidates[0]!
  const beginIndex = lines.indexOf(begin)
  const endIndex = lines.indexOf(end)
  const parsed = BEGIN_RE.exec(begin.content)
  if (!parsed || endIndex <= beginIndex) {
    throw new Error(
      "Found a malformed LyraShield hook marker; refusing to modify user hook content."
    )
  }
  const metadata: ManagedBlockMetadata = {
    created: parsed[1] === "1",
    shebangAdded: parsed[2] === "1",
    separatorAdded: parsed[3] === "1",
    eol: parsed[4] === "crlf" ? "\r\n" : "\n",
  }
  const expected = renderOwnedLines(metadata)
  const actual = lines.slice(beginIndex, endIndex + 1).map((line) => line.content)
  const usesExpectedEol = lines
    .slice(beginIndex, endIndex)
    .every((line) => line.eol === metadata.eol)
  if (
    actual.length !== expected.length ||
    actual.some((line, index) => line !== expected[index]) ||
    !usesExpectedEol ||
    (end.eol !== "" && end.eol !== metadata.eol)
  ) {
    throw new Error("The LyraShield hook block was edited; refusing to overwrite it.")
  }
  if (metadata.separatorAdded && begin.start < metadata.eol.length) {
    throw new Error("The LyraShield hook separator is missing; refusing to rewrite the hook.")
  }
  return { metadata, begin, end }
}

function preferredEol(text: string): "\n" | "\r\n" {
  if (/\r(?!\n)/.test(text)) {
    throw new Error(
      "The existing hook uses unsupported bare-CR line endings; refusing to rewrite it."
    )
  }
  const lastNewline = text.lastIndexOf("\n")
  return lastNewline > 0 && text[lastNewline - 1] === "\r" ? "\r\n" : "\n"
}

function recognizedLegacyEol(text: string): "\n" | "\r\n" | undefined {
  if (text.replace(/\r\n/g, "\n") !== LEGACY_HOOK_LF) return undefined
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function containsLegacyHook(text: string): boolean {
  return text.includes(LEGACY_HOOK_COMMENT) || text.includes(LEGACY_HOOK_COMMAND)
}

function assertShellCompatibleHook(text: string): void {
  const firstLine = splitLines(text)[0]?.content ?? ""
  if (!firstLine.startsWith("#!")) return

  const parts = firstLine.slice(2).trim().split(/\s+/).filter(Boolean)
  let interpreter = parts[0]
  if (!interpreter) {
    throw new Error("The existing pre-commit hook has an empty shebang; refusing to modify it.")
  }
  if (path.basename(interpreter) === "env") {
    const envArguments = parts.slice(1)
    if (envArguments[0] === "-S") {
      interpreter = envArguments[1] ?? ""
    } else if (envArguments[0]?.startsWith("-")) {
      throw new Error(
        "The existing pre-commit hook uses an unsupported env shebang; refusing to append shell code."
      )
    } else {
      interpreter = envArguments[0] ?? ""
    }
  }
  if (!POSIX_SHELLS.has(path.basename(interpreter))) {
    throw new Error(
      "The existing pre-commit hook does not use a supported POSIX shell shebang; refusing to append shell code."
    )
  }
}

async function writeTemporaryFile(
  hookPath: string,
  content: Buffer,
  mode: number
): Promise<string> {
  const temporaryPath = `${hookPath}.lyrashield-${randomUUID()}.tmp`
  const handle = await open(temporaryPath, "wx", mode)
  try {
    await handle.chmod(mode)
    await handle.writeFile(content)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temporaryPath, { force: true })
    throw error
  }
  await handle.close()
  return temporaryPath
}

async function atomicCreate(hookPath: string, content: Buffer, mode: number): Promise<void> {
  const temporaryPath = await writeTemporaryFile(hookPath, content, mode)
  try {
    await assertSafeDirectory(path.dirname(hookPath))
    await link(temporaryPath, hookPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function atomicReplace(
  hookPath: string,
  content: Buffer,
  mode: number,
  expected: HookSnapshot
): Promise<void> {
  const temporaryPath = await writeTemporaryFile(hookPath, content, mode)
  try {
    await assertSafeDirectory(path.dirname(hookPath))
    const current = await readHookSnapshot(hookPath)
    if (!sameSnapshot(expected, current)) {
      throw new Error("The pre-commit hook changed during installation; preserving the newer file.")
    }
    await rename(temporaryPath, hookPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function removeOwnedHook(hookPath: string, expected: HookSnapshot): Promise<void> {
  await assertSafeDirectory(path.dirname(hookPath))
  const current = await readHookSnapshot(hookPath)
  if (!sameSnapshot(expected, current)) {
    throw new Error("The pre-commit hook changed during removal; preserving the newer file.")
  }
  await unlink(hookPath)
}

async function installHook(hookPath: string): Promise<InstallResult> {
  await ensureHooksDirectory(path.dirname(hookPath))
  await assertSafeHookPath(hookPath)
  const snapshot = await readHookSnapshot(hookPath)
  const currentText = snapshot ? decodeHook(snapshot.content) : ""
  const existingBlock = parseManagedBlock(currentText)
  if (existingBlock) {
    return { outcome: "unchanged", executable: !!snapshot && (snapshot.mode & 0o111) !== 0 }
  }
  const legacyEol = snapshot ? recognizedLegacyEol(currentText) : undefined
  if (snapshot && containsLegacyHook(currentText) && !legacyEol) {
    throw new Error(
      "This hook contains the legacy LyraShield npx block alongside other content. Remove only the old LyraShield comment/command manually, preserve your other hook lines, then rerun hook install."
    )
  }
  if (snapshot && !legacyEol) assertShellCompatibleHook(currentText)

  let metadata: ManagedBlockMetadata
  let baseText: string
  let outcome: InstallResult["outcome"] = "installed"
  if (!snapshot) {
    const eol = "\n"
    metadata = { created: true, shebangAdded: true, separatorAdded: false, eol }
    baseText = `#!/bin/sh${eol}`
  } else if (legacyEol) {
    metadata = {
      created: false,
      shebangAdded: false,
      separatorAdded: false,
      eol: legacyEol,
    }
    baseText = `#!/bin/sh${legacyEol}`
    outcome = "migrated"
  } else {
    const eol = preferredEol(currentText)
    const shebangAdded = currentText.length === 0
    baseText = shebangAdded ? `#!/bin/sh${eol}` : currentText
    const separatorAdded = baseText.length > 0 && !baseText.endsWith("\n")
    metadata = { created: false, shebangAdded, separatorAdded, eol }
    if (separatorAdded) baseText += eol
  }

  const lines = renderOwnedLines(metadata)
  const updated = `${baseText}${lines.join(metadata.eol)}${metadata.eol}`
  const updatedBuffer = Buffer.from(updated, "utf8")
  await assertSafeHookPath(hookPath)
  try {
    if (snapshot) {
      await atomicReplace(hookPath, updatedBuffer, snapshot.mode, snapshot)
    } else {
      await atomicCreate(hookPath, updatedBuffer, 0o755)
    }
    const installed = await readHookSnapshot(hookPath)
    return {
      outcome,
      executable: !!installed && (installed.mode & 0o111) !== 0,
    }
  } catch (error) {
    // Concurrent installs are safe to treat as success only when the winner
    // installed the exact, still-valid managed block.
    const raced = await readHookSnapshot(hookPath).catch(() => undefined)
    if (raced && parseManagedBlock(decodeHook(raced.content))) {
      return { outcome: "unchanged", executable: (raced.mode & 0o111) !== 0 }
    }
    throw error
  }
}

async function uninstallHook(hookPath: string): Promise<"removed" | "unchanged"> {
  await assertSafeHookPath(hookPath)
  const snapshot = await readHookSnapshot(hookPath)
  if (!snapshot) return "unchanged"
  const text = decodeHook(snapshot.content)
  const block = parseManagedBlock(text)
  if (!block) return "unchanged"

  let start = block.begin.start
  let end = block.end.contentEnd
  if (block.end.eol === block.metadata.eol) end = block.end.end
  const suffix = text.slice(end)
  if (block.metadata.separatorAdded && suffix.length === 0) {
    start -= block.metadata.eol.length
  }
  let remaining = text.slice(0, start) + text.slice(end)

  if (block.metadata.shebangAdded) {
    const addedShebang = `#!/bin/sh${block.metadata.eol}`
    if (remaining.startsWith(addedShebang)) remaining = remaining.slice(addedShebang.length)
  }

  if (block.metadata.created && remaining.length === 0) {
    await removeOwnedHook(hookPath, snapshot)
    return "removed"
  }

  await atomicReplace(hookPath, Buffer.from(remaining, "utf8"), snapshot.mode, snapshot)
  return "removed"
}

export async function handleHook(args: string[], output: Output): Promise<number> {
  const [sub] = args
  if (sub !== "install" && sub !== "remove") {
    output.error("usage: lyrashield hook install|remove")
    return 2
  }

  try {
    const hookPath = await resolveHookPath(process.cwd())
    if (sub === "install") {
      const result = await installHook(hookPath)
      if (!result.executable) {
        output.warn(
          `The LyraShield advisory block is present at ${hookPath}, but the hook is not executable, so Git will not run it. Its existing mode was preserved; make it executable with chmod +x if you want it active.`
        )
      } else {
        output.log(
          result.outcome === "migrated"
            ? `Replaced the recognized legacy network hook with the offline advisory block at ${hookPath}`
            : result.outcome === "installed"
              ? `Installed optional advisory pre-commit hook at ${hookPath}`
              : `LyraShield advisory pre-commit hook is already installed at ${hookPath}`
        )
      }
      return 0
    }

    const result = await uninstallHook(hookPath)
    output.log(
      result === "removed"
        ? `Removed LyraShield's advisory block from ${hookPath}`
        : `No LyraShield-managed block found at ${hookPath}`
    )
    return 0
  } catch (error) {
    output.error(toErrorMessage(error))
    return 2
  }
}
