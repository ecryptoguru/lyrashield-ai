async function verifySandboxRemoved(scanId: string): Promise<boolean | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scanId) || scanId.includes("..")) {
    return undefined
  }
  try {
    // Use `docker ps -a` (all containers), not just running ones. A sandbox that
    // exited but was never removed must still count as "not removed" — otherwise a
    // stopped container reports sandboxRemoved:true and leaks the resource receipt.
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-a", "--filter", `label=strix-run-id=${scanId}`, "--quiet"],
      { timeout: SANDBOX_RECEIPT_TIMEOUT_MS, maxBuffer: 16 * 1024 }
    )
    return stdout.trim() === ""
  } catch (error) {
    logger.warn("Could not verify terminal sandbox cleanup", {
      scanId,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}