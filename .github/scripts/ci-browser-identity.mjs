import { dirname, isAbsolute, join } from "node:path"

export function checkPlaywrightVersions(versions) {
  const version = versions[0]
  if (
    versions.length !== 3 ||
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    versions.some((entry) => entry !== version)
  )
    throw new Error("Locked Playwright package versions disagree")
  return version
}

export function chromiumIdentity(browsers, fullPath) {
  if (!Array.isArray(browsers) || typeof fullPath !== "string" || !isAbsolute(fullPath))
    throw new Error("Locked Chromium identity is unavailable")
  const entries = ["chromium", "chromium-headless-shell"].map((name) => {
    const matches = browsers.filter((entry) => entry?.name === name)
    const browser = matches[0]
    if (
      matches.length !== 1 ||
      typeof browser.revision !== "string" ||
      !/^\d{1,8}$/.test(browser.revision) ||
      typeof browser.browserVersion !== "string" ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(browser.browserVersion)
    )
      throw new Error("Locked Chromium metadata is invalid")
    return browser
  })
  const [full, shell] = entries
  if (!fullPath.endsWith(`/chromium-${full.revision}/chrome-linux64/chrome`))
    throw new Error("Unexpected locked Chromium cache path")
  return {
    binary: join(
      dirname(dirname(dirname(fullPath))),
      `chromium_headless_shell-${shell.revision}/chrome-headless-shell-linux64/chrome-headless-shell`
    ),
    version: shell.browserVersion,
  }
}
