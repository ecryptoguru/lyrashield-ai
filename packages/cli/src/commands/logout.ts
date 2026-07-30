import { removeCredentials } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleLogout(_args: string[], output: Output): Promise<number> {
  await removeCredentials()
  output.log("Logged out. Stored credentials removed.")
  return 0
}
