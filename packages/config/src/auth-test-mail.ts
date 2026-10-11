interface AuthTestMailConfig {
  directory?: string
  nodeEnv?: string
  authUrl: string
  appUrl: string
  databaseUrl: string
  brevoApiKey?: string
  disposable?: string
}

/** Reset-link capture is confined to an explicitly disposable local app. */
export function authTestMailConfigAllowed(config: AuthTestMailConfig): boolean {
  if (!config.directory) return true
  if (
    !["development", "test"].includes(config.nodeEnv ?? "") ||
    config.brevoApiKey ||
    config.disposable !== "1"
  ) {
    return false
  }
  try {
    const auth = new URL(config.authUrl)
    const app = new URL(config.appUrl)
    const database = new URL(config.databaseUrl)
    const loopback = new Set(["127.0.0.1", "[::1]"])
    const databaseName = decodeURIComponent(database.pathname.slice(1))
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
      ["postgres:", "postgresql:"].includes(database.protocol) &&
      (loopback.has(database.hostname) || database.hostname === "localhost") &&
      (databaseName === "lyrashield" ||
        /(?:^|[_-])(?:test|ci|disposable)(?:$|[_-])/i.test(databaseName))
    )
  } catch {
    return false
  }
}
