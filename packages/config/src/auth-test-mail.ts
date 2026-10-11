interface AuthTestMailConfig {
  directory?: string
  ownedDirectory?: string
  nodeEnv?: string
  authUrl: string
  appUrl: string
  databaseUrl: string
  databaseSystemUrl?: string
  brevoApiKey?: string
  disposable?: string
}

/** Database URLs used by the reset-mail proof may target only a named loopback DB. */
export function isSafeDisposableDatabaseUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const database = new URL(value)
    const databaseName = decodeURIComponent(database.pathname.slice(1))
    const queryKeys = [...database.searchParams.keys()]
    const hasSafeQuery =
      queryKeys.length === 0 ||
      (queryKeys.length === 1 &&
        queryKeys[0] === "schema" &&
        database.searchParams.get("schema") === "public")
    return (
      ["postgres:", "postgresql:"].includes(database.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) &&
      !value.includes("#") &&
      hasSafeQuery &&
      /^[\w-]+$/.test(databaseName) &&
      (databaseName === "lyrashield" ||
        /(?:^|[_-])(?:test|ci|disposable)(?:$|[_-])/i.test(databaseName))
    )
  } catch {
    return false
  }
}

/** Reset-link capture is confined to an explicitly disposable local app. */
export function authTestMailConfigAllowed(config: AuthTestMailConfig): boolean {
  if (!config.directory) return true
  if (
    config.ownedDirectory !== config.directory ||
    !["development", "test"].includes(config.nodeEnv ?? "") ||
    config.brevoApiKey ||
    config.disposable !== "1"
  ) {
    return false
  }
  try {
    const auth = new URL(config.authUrl)
    const app = new URL(config.appUrl)
    const loopback = new Set(["127.0.0.1", "[::1]"])
    return (
      [auth, app].every(
        (url) =>
          url.protocol === "http:" &&
          loopback.has(url.hostname) &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
      ) &&
      auth.origin === app.origin &&
      isSafeDisposableDatabaseUrl(config.databaseUrl) &&
      (!config.databaseSystemUrl || isSafeDisposableDatabaseUrl(config.databaseSystemUrl))
    )
  } catch {
    return false
  }
}
