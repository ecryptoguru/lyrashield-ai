# @lyrashield/logger

Shared, redaction-first logger for the LyraShield monorepo.

## Purpose

- Writes JSON log lines to `console` with `debug`, `info`, `warn`, and `error` levels.
- Redacts values whose keys contain sensitive markers (`password`, `secret`, `token`, `authorization`, `apikey`, `credential`, `cookie`, etc.).
- Truncates deep or circular objects to prevent log amplification.
- `LOG_LEVEL` environment variable controls the minimum log level (default `info`).

## Main exports

- `logger` — default scoped-to-root logger.
- `createLogger(scope)` — returns a logger prefixed with a scope string.
- `LogLevel`, `LogEntry` types.

## Usage

```ts
import { createLogger } from "@lyrashield/logger"

const log = createLogger("worker")
log.info("Scan started", { scanId, targetId })
```

## See also

- `packages/config` for `LOG_LEVEL` configuration.
