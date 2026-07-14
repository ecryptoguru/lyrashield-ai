import { describe, it, expect } from "vitest"
import { checkScanUrlSafe, parseIpLiteral, isBlockedIp, type HostResolver } from "./ssrf"

// Stub resolver so tests never touch the network.
const stub: HostResolver = async (host) => {
  const map: Record<string, string[]> = {
    "good.example": ["93.184.216.34"],
    "example.com": ["93.184.216.34"],
    "evil.internal": ["10.0.0.5"],
    "rebind.example": ["1.2.3.4", "169.254.169.254"], // one public, one metadata
    "aws.evil": ["169.254.169.254"],
  }
  const hit = map[host]
  if (hit) return hit
  throw new Error(`no stub for ${host}`)
}

describe("checkScanUrlSafe", () => {
  const blocked: Array<[string, string]> = [
    ["http://127.0.0.1/", "loopback"],
    ["http://[::1]/", "IPv6 loopback in brackets"],
    ["http://[::ffff:169.254.169.254]/", "IPv4-mapped metadata via IPv6"],
    ["http://169.254.169.254/", "cloud metadata"],
    ["http://10.0.0.5/", "private 10/8"],
    ["http://192.168.1.1/", "private 192.168/16"],
    ["http://172.16.0.1/", "private 172.16/12"],
    ["http://0.0.0.1/", "0.0.0.0/8"],
    ["http://100.64.0.1/", "CGNAT 100.64/10"],
    ["http://198.18.0.1/", "benchmarking 198.18/15"],
    ["http://2130706433/", "decimal-encoded 127.0.0.1"],
    ["http://0x7f000001/", "hex-encoded 127.0.0.1"],
    ["http://0177.0.0.1/", "octal-encoded 127.0.0.1"],
    ["http://[fc00::1]/", "unique-local fc00::/7"],
    ["http://[fe80::1]/", "link-local fe80::/10"],
    ["http://[fec0::1]/", "site-local fec0::/10"],
    ["http://[64:ff9b:1::a00:1]/", "RFC 8215 local-use translation prefix"],
    ["https://user:password@example.com/", "URL credentials"],
    ["https://example.com/path?q=secret", "URL query parameters"],
    ["http://localhost/", "localhost name"],
    ["http://metadata.google.internal/", "gcp metadata name"],
    ["http://foo.localhost/", ".localhost suffix"],
    ["http://127.0.0.1./", "trailing dot"],
    ["ftp://127.0.0.1/", "non-http scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["http://evil.internal/", "domain resolving to private"],
    ["http://rebind.example/", "domain with one metadata address"],
    ["http://aws.evil/", "domain resolving to metadata"],
    ["definitely not a url", "invalid url"],
  ]

  it.each(blocked)("blocks %s (%s)", async (url) => {
    const result = await checkScanUrlSafe(url, stub)
    expect(result.safe).toBe(false)
  })

  const allowed: string[] = [
    "http://8.8.8.8/",
    "https://1.1.1.1/",
    "http://[2606:4700:4700::1111]/",
    "https://good.example/",
    "https://example.com/path",
    "http://93.184.216.34/",
  ]

  it.each(allowed)("allows %s", async (url) => {
    const result = await checkScanUrlSafe(url, stub)
    expect(result.safe).toBe(true)
  })

  it("fails closed when a resolver returns a non-IP value", async () => {
    const result = await checkScanUrlSafe("https://example.com", async () => ["localhost"])
    expect(result).toEqual({ safe: false, reason: "dns_resolution_failed" })
  })
})

describe("parseIpLiteral / isBlockedIp", () => {
  it("canonicalizes encoded IPv4 literals", () => {
    expect(parseIpLiteral("2130706433")).toBe("127.0.0.1")
    expect(parseIpLiteral("0x7f000001")).toBe("127.0.0.1")
    expect(parseIpLiteral("0177.0.0.1")).toBe("127.0.0.1")
  })
  it("returns null for domains", () => {
    expect(parseIpLiteral("example.com")).toBeNull()
  })
  it("flags IPv4-mapped IPv6 loopback", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true)
  })
  it("allows public addresses", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false)
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false)
  })
})
