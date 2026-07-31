import process from "node:process"

export interface Output {
  json: boolean
  quiet: boolean
  log(...args: unknown[]): void
  notice(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(message: unknown, exitCode?: number): void
  result(data: unknown): void
  fail(error: string, exitCode?: number): never
}

export function isTTY(): boolean {
  return !!process.stdout.isTTY && !process.env.CI
}

export function noColor(): boolean {
  return !!process.env.NO_COLOR || !isTTY()
}

function fmt(c: string, s: string): string {
  return noColor() ? s : `${c}${s}\x1b[0m`
}

export function red(s: string): string {
  return fmt("\x1b[31m", s)
}

export function yellow(s: string): string {
  return fmt("\x1b[33m", s)
}

export function green(s: string): string {
  return fmt("\x1b[32m", s)
}

export function cyan(s: string): string {
  return fmt("\x1b[36m", s)
}

export function dim(s: string): string {
  return fmt("\x1b[2m", s)
}

export function redactKey(key: string | undefined): string {
  if (!key) return "not set"
  if (!key.startsWith("lsk_")) return "non-LyraShield key"
  return `lsk_${key.slice(-4)}`
}

function stringifyForConsole(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value, null, 2)
}

export function createOutput({ json, quiet = false }: { json: boolean; quiet?: boolean }): Output {
  return {
    json,
    quiet,
    log(...args) {
      if (quiet || json) return
      console.log(args.map(stringifyForConsole).join(" "))
    },
    notice(...args) {
      if (quiet || json) return
      console.error(args.map(stringifyForConsole).join(" "))
    },
    warn(...args) {
      if (quiet || json) return
      console.error(yellow("warning:"), ...args)
    },
    error(message, exitCode = 2) {
      if (quiet) return
      if (json) {
        console.log(JSON.stringify({ ok: false, error: stringifyForConsole(message) }, null, 2))
        process.exit(exitCode)
      }
      console.error(red("error:"), message)
    },
    result(data) {
      if (json) {
        console.log(JSON.stringify({ ok: true, data }, null, 2))
        return
      }
      console.log(stringifyForConsole(data))
    },
    fail(error, exitCode = 1) {
      if (json) {
        console.log(JSON.stringify({ ok: false, error }, null, 2))
      } else {
        console.error(red("error:"), error)
      }
      process.exit(exitCode)
    },
  }
}

export function printJsonError(error: string, exitCode = 1): never {
  console.log(JSON.stringify({ ok: false, error }, null, 2))
  process.exit(exitCode)
}

export function printJsonResult(data: unknown): void {
  console.log(JSON.stringify({ ok: true, data }, null, 2))
}
