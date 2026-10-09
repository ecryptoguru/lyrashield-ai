const KNOWN_WRANGLER_PROXY_FAILURE = [
  "Error in ProxyController: Error inside ProxyWorker",
  "message: 'Network connection lost.'",
  "ProxyController2.onProxyWorkerMessage",
  "#handleLoopbackCustomFetchService",
]

export function isKnownWranglerProxyFailure(logs) {
  return logs.some((log) => KNOWN_WRANGLER_PROXY_FAILURE.every((marker) => log.includes(marker)))
}
