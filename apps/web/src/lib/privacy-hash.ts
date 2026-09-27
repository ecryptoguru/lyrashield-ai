const MIN_IP_HASH_SALT_LENGTH = 32

export async function hashPrivacyValue(value: string): Promise<string> {
  const salt = process.env.IP_HASH_SALT
  if (!salt || salt.length < MIN_IP_HASH_SALT_LENGTH) {
    throw new Error("IP_HASH_SALT must contain at least 32 characters")
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value + salt))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
