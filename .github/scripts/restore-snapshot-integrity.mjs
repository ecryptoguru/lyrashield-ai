import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"

// pg_restore --data-only and pg_dump --data-only use one physical line per
// COPY row (embedded newlines are escaped). Values never leave private files.
// Hash sorted row digests to compare multisets without depending on row order.
export async function copySnapshot(lines, dumpSha256) {
  if (!/^[a-f0-9]{64}$/.test(dumpSha256)) throw new Error("invalid-dump-binding")
  const tables = {}
  let current
  const identifier = '(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*)'
  const copyHeader = new RegExp(`^COPY (${identifier}\\.${identifier}) \\((.*)\\) FROM stdin;$`)
  const directory = await mkdtemp(join(tmpdir(), "lyra-snapshot-"))
  try {
    for await (const line of lines) {
      if (line.length > 16 * 1024 * 1024) throw new Error("row-size-limit")
      if (current) {
        if (line === "\\.") {
          current.stream.end()
          await once(current.stream, "finish")
          // External sort bounds working memory and spills only row digests into
          // this private 0700 directory. It handles arbitrarily reordered rows.
          const sorted = spawn("sort", ["-S", "16M", current.path], {
            env: { ...process.env, LC_ALL: "C", TMPDIR: directory },
            stdio: ["ignore", "pipe", "ignore"],
          })
          const completion = once(sorted, "close")
          const hash = createHash("sha256")
          for await (const chunk of sorted.stdout) hash.update(chunk)
          const [status] = await completion
          if (status !== 0) throw new Error("snapshot-sort-failed")
          tables[current.name] = {
            columns: current.columns,
            count: current.count,
            sha256: hash.digest("hex"),
          }
          await rm(current.path)
          current = undefined
        } else {
          current.count++
          if (!current.stream.write(createHash("sha256").update(line).digest("hex") + "\n"))
            await once(current.stream, "drain")
        }
        continue
      }
      if (!line.startsWith("COPY ")) continue
      const match = copyHeader.exec(line)
      if (!match || Object.hasOwn(tables, match[1])) throw new Error("invalid-copy-header")
      const file = join(directory, "row-digests")
      current = {
        name: match[1],
        columns: match[2],
        count: 0,
        path: file,
        stream: createWriteStream(file, { mode: 0o600 }),
      }
    }
    if (current || !Object.keys(tables).length) throw new Error("incomplete-copy-snapshot")
    return { version: 1, dumpSha256, tables: Object.fromEntries(Object.entries(tables).sort()) }
  } finally {
    if (current) {
      current.stream.destroy()
      await once(current.stream, "close").catch(() => {})
    }
    await rm(directory, { recursive: true, force: true })
  }
}

export function verifySnapshot(expected, actual) {
  if (
    expected.version !== 1 ||
    actual.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(expected.dumpSha256) ||
    expected.dumpSha256 !== actual.dumpSha256 ||
    JSON.stringify(expected.tables) !== JSON.stringify(actual.tables)
  ) {
    throw new Error("snapshot-content-mismatch")
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, first, second, output] = process.argv.slice(2)
    if (mode === "capture") {
      const snapshot = await copySnapshot(
        createInterface({ input: createReadStream(first), crlfDelay: Infinity }),
        second
      )
      await writeFile(output, JSON.stringify(snapshot), { mode: 0o600 })
    } else if (mode === "verify") {
      verifySnapshot(
        JSON.parse(await readFile(first, "utf8")),
        JSON.parse(await readFile(second, "utf8"))
      )
    } else throw new Error("invalid-mode")
  } catch {
    // Table names, counts, connection strings and raw data are private.
    console.error("restore/snapshot-integrity-failed")
    process.exitCode = 1
  }
}
