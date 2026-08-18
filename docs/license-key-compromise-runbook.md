# License Signing Key Compromise Runbook (FF4)

> **Severity: Critical.** Execute immediately upon suspicion that the ed25519
> license signing private key has been exposed. Time-to-rotate is the primary
> damage-control metric.

## When to use this runbook

Trigger this runbook when **any** of the following occur:

- The `LICENSE_SIGNING_PRIVATE_KEY` env var or Azure Key Vault secret is found
  in a log, commit, artifact, or third-party system outside its intended store.
- An attacker demonstrates the ability to forge valid license signatures.
- A Key Vault access audit shows unauthorized access to the signing key.
- An insider with key access departs under adversarial circumstances.
- Any unexplained valid license file appears that was not issued by the
  `/api/licenses/issue` or `/api/licenses/activate` endpoints.

## Prerequisites

- Founder (OWNER) access to the LyraShield platform.
- Azure Key Vault admin access (production signing key store).
- Ability to ship a desktop app update (signed and notarized).
- Brevo email access for customer notification.

---

## Step 1 — Generate a new ed25519 keypair in Azure Key Vault

1. **Rotate the Key Vault key.** In the Azure Portal, navigate to the Key Vault
   that stores the license signing key and create a new ed25519 key:
   - Key name: `license-signing-v{N}` (increment the version, e.g. `v2`).
   - Key type: `Ed25519`.
   - Set rotation policy to notify 30 days before expiry.

2. **Export the public key** as a SPKI PEM. This will be bundled into the next
   desktop app release so the client trusts signatures from the new key.

3. **Update `LICENSE_SIGNING_KEY_ID`** to the new key identifier (e.g.
   `license-key-v2`). This is how the client selects the correct public key
   for verification and how revocation lists are scoped.

4. **Do NOT delete the old key** from Key Vault yet — it is needed during the
   dual-sign overlap window (Step 3).

---

## Step 2 — Ship an update that trusts the new key + bundles a revocation list

1. **Add the new public key** to the desktop app's bundled trusted keys list.
   The client should accept signatures from both the old and new keys during
   the overlap window, then drop the old key after the window closes.

2. **Generate a revocation list** of all licenses signed by the compromised key.
   Query the database:

   ```sql
   SELECT id, owner_email, sku, signing_key_id
   FROM "License"
   WHERE signing_key_id = 'license-key-v1'  -- the compromised key ID
   ORDER BY created_at;
   ```

3. **Bundle the revocation list** into the desktop app update as a signed JSON
   file. The client must refuse any license file whose `signingKeyId` appears
   in the revocation list **after** the overlap window closes.

4. **Ship the update.** The update itself must be installable by all users
   (including those whose update eligibility has expired) — this is a security
   update that overrides the normal eligibility gate. The perpetual fallback
   policy is suspended for this specific build.

---

## Step 3 — Dual-sign during the overlap window

1. **Update the server** to sign new and re-issued licenses with the **new**
   key only (`LICENSE_SIGNING_KEY_ID = license-key-v2`).

2. **During the overlap window (recommended: 30 days):**
   - The desktop client accepts signatures from both `license-key-v1` (old)
     and `license-key-v2` (new) public keys.
   - The server signs exclusively with the new key.
   - Any license file signed by the old key that is NOT in the revocation list
     remains valid until the user re-activates (which re-issues with the new key).

3. **After the overlap window closes:**
   - The desktop client drops trust in the old key entirely.
   - Any license file still signed by the old key is rejected; the user must
     re-activate to get a new-key signature.

---

## Step 4 — Notify affected customers with new license keys

1. **Identify affected customers** from the revocation list query in Step 2.

2. **Generate new license keys** for each affected license. The new keys are
   associated with the same License row (or a new License row if the original
   is revoked) and signed with the new key.

3. **Send a notification email** to each affected customer via Brevo:
   - Subject: `Action required: Your LyraShield license key has been rotated`
   - Body: Explain that a security incident required key rotation, provide the
     new license key, and link to re-activation instructions.
   - Do NOT include the license file in the email — the user must re-activate
     to receive a freshly signed file.

4. **Log all re-issued keys** in the audit log for post-incident review.

---

## Step 5 — Post-incident review

1. **Document the timeline:** when the compromise was detected, when each step
   was executed, and when the overlap window closed.

2. **Conduct a root-cause analysis:** how was the key exposed? Was it an
   insider, a misconfiguration, a CI/CD leak, or a Key Vault access control
   failure?

3. **Update access controls:**
   - Restrict Key Vault access to the minimum necessary principals.
   - Enable Key Vault firewall and private endpoints if not already enabled.
   - Review CI/CD pipelines for any path that could expose the key.

4. **Verify remediation:**
   - Confirm no licenses signed by the old key are accepted by the latest
     desktop client.
   - Confirm the revocation list is complete and bundled.
   - Confirm all affected customers have been notified and re-activated.

5. **File an incident report** in the LyraShield documentation system with
   the timeline, root cause, and remediation steps. Notify the founder.

---

## Quick reference

| Step | Action                                     | Owner                 | Target time |
| ---- | ------------------------------------------ | --------------------- | ----------- |
| 1    | Generate new keypair in Key Vault          | Founder / Azure admin | < 1 hour    |
| 2    | Ship update with new key + revocation list | Engineering           | < 24 hours  |
| 3    | Dual-sign during overlap window            | Engineering           | 30 days     |
| 4    | Notify affected customers                  | Founder / Support     | < 48 hours  |
| 5    | Post-incident review                       | Founder               | < 7 days    |
