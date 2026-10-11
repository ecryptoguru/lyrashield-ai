import { cleanupOwnedAuthTestMailDirectory } from "../../packages/auth/src/auth-test-mail-directory"

export default async function teardown() {
  await cleanupOwnedAuthTestMailDirectory(
    process.env.LYRASHIELD_TEST_AUTH_MAIL_DIR,
    process.env.LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR
  )
}
