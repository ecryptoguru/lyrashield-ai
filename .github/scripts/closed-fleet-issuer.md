# Closed canonical fleet issuer foundation

This module is an isolated rehearsal of qualification construction and managed
RSA signing. It has no workflow or command-line entry point, no Azure executor,
and no production credential discovery. `issueRuntimeFleetQualification()`
always throws before exchange or signing because trustworthy production
inventory, journal, rollback and create-once intent readers are not wired.
Existing health-only workflows and all release/worker holds remain unchanged.

`createClosedFleetIssuer()` receives dependencies from trusted program code. Its
only operation, `issueCandidate()`, accepts no candidate bytes or generic signing
payload. It constructs canonical JSON from seven mandatory authenticated reader
receipts, authenticates the protected hosted GitHub issuer, and verifies the raw
Sigstore bundle through the reviewed attestation verifier. A saved `gh`
verification-result file cannot replace that bundle. The optional process seam
exists for local tests; it is not a workflow input.

Every signed output uses the distinct `lyrashield-closed-fleet-candidate/1`
schema, `kind: closed-fleet-candidate` and `productionQualification: false`.
The result also carries `qualified: false`. It cannot satisfy the paired
consumer's `lyrashield-qualified-fleet/2` schema. Even complete synthetic evidence
and locally valid signatures never become production qualification.

## Evidence and signature contract

The seven reader ports return canonical, signed UTF-8 envelopes, not booleans,
request objects or unsigned saved JSON. Each has a separate pinned RSA key and
key identity, distinct from the managed signer and issuance-intent authority.
Signatures, role, owner, exact fleet checksum, authority epoch and validity must
match before any credential exchange. Strict Zod schemas reject unknown fields.
RSA trust separation compares SHA-256 fingerprints of imported, normalized SPKI
public keys, including modulus and exponent. Relabeling a key or adding a leading
zero to its JWK integer cannot create another trust root. Nonminimal or
noncanonical base64url integer encodings and malformed key material are rejected.

| Port      | Required bindings                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fleet     | Exact product/engine revisions and web, scanner, proxy, worker, sandbox, broker, supervisor and provider-gateway digests, migrations and runtime policy                              |
| Source    | Immutable product/engine repository and owner IDs, Git source-tree object IDs and CI receipt digests, exact CI workflows/runs/attempts, and separate publication source/run/attempt  |
| Inventory | Raw provenance-bundle checksum and native amd64/arm64 manifest, inventory, coverage and extractor digests; every enumerated package covered, bounded to 10,000 packages per platform |
| Migration | Exact migration checksum and schema proof digest                                                                                                                                     |
| Policy    | Exact runtime policy and policy proof digests                                                                                                                                        |
| Journal   | Epoch, sequence, equal authenticated supervisor/independent/PostgreSQL head digests and confirmed operation digest                                                                   |
| Rollback  | Distinct held baseline product/worker identities, complete rollback tuple, matching engine/migrations, archive digest and journal proof digest                                       |

The source receipt binds selected engine revision separately from publication
workflow source; a SLSA publication statement alone cannot establish selected
runtime source. Likewise, authenticated receipt metadata is not independent
proof that native extraction, package evaluation or journal readback actually
occurred. Production reader implementations and their reviewed trust anchors
must establish those facts before this boundary can be promoted.

After construction, an eighth independent authority must return an authenticated
create-once `CLAIMED` issuance-intent receipt binding exact candidate checksum,
nonce, owner and epoch. Existing or replayed claims are rejected. An ambiguous
response leaves the issuer instance consumed without exchange or signing. The
journal refresh must be a newly signed readback bound to the candidate nonce,
checksum, full fleet binding and epoch, with the expected authenticated heads
and a fresh issue time. Replaying the earlier signed snapshot cannot satisfy
that challenge. Issuer identity is also refreshed before exchange; changed
journal heads, epoch, source or run prevent signing. This local one-shot guard does not
substitute for a durable create-once authority across process restarts. That
production implementation is absent.

Candidate validity is capped at 15 minutes and at the shortest authenticated
evidence/OIDC expiry. Expiry is checked before exchange, between login/sign and
after signing; the standalone signature verifier also checks current validity.
Canonical bytes and the complete tuple, source, inventory, journal, rollback,
evidence checksums, nonce and timestamps are covered by the signature.

The signing flow reuses the health boundary's source-controlled managed-key
configuration, RS256/3072-bit RSA requirements and fixed Azure login/key-sign
argument shapes. Its Azure dependency is mandatory; there is no live default.
Only the internally constructed canonical candidate SHA-256 is sent to signing.
The returned signature must verify under the exact pinned key before output;
logout runs on signing failure. Reader/Azure errors are sanitized. The returned
signature envelope is immutable.

## Verification and remaining work

Local tests generate keys in memory, cryptographically sign GitHub OIDC and
independent evidence fixtures, and mock the Key Vault digest-signing primitive.
They cover missing/ambiguous/unsigned inputs, tampering, tuple/source/epoch drift,
incomplete native inventory, fork/issuer/workflow substitutions, replay and lost
acknowledgements, journal refresh, expiry and invalid managed signatures. Strict
TypeScript verification uses `tsconfig.fleet-qualification.json`; Zod remains
owned by the existing web workspace dependency. No keys or receipts are retained.

Actual trusted product/engine CI and native inventory readers, original journal
envelope/authenticated R2/PostgreSQL readback, rollback archive verification,
durable issuance-intent authority and their reviewed signing roots are still
unimplemented at this boundary. GitHub JWKS must come from the trusted live
resolver, never caller-supplied keys. This closed dependency-injection harness
does not establish that live trust chain. No actual managed key candidate
qualification or live issuance occurred. A separate promotion action lease and
its durable replay protection remain required before any future mutation or
admission release.
