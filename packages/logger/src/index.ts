type LogLevel = "debug" | "info" | "warn" | "error"

interface LogEntry {
  level: LogLevel
  message: string
  timestamp: string
  [key: string]: unknown
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function getMinLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined
  return envLevel && envLevel in LOG_LEVELS ? envLevel : "info"
}

const CACHED_MIN_LEVEL = getMinLevel()

function formatLog(entry: LogEntry): string {
  return JSON.stringify(entry)
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LOG_LEVELS[level] < LOG_LEVELS[CACHED_MIN_LEVEL]) return

  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  }

  const formatted = formatLog(entry)

  if (level === "error") {
    console.error(formatted)
  } else if (level === "warn") {
    console.warn(formatted)
  } else {
    console.log(formatted)
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: Record<string, unknown>) =>
      log("debug", message, { scope, ...meta }),
    info: (message: string, meta?: Record<string, unknown>) =>
      log("info", message, { scope, ...meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      log("warn", message, { scope, ...meta }),
    error: (message: string, meta?: Record<string, unknown>) =>
      log("error", message, { scope, ...meta }),
  }
}

export type { LogLevel, LogEntry }
