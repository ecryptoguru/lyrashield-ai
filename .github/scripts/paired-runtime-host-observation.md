# Installed runtime authority observation

`verifyPairedAuthority()` now calls the existing nonce-bound, exact-Git Azure VM
transport's read-only `runtime-authority` operation. It does not create an authority,
install a service, obtain signing credentials or perform execution. An absent or
invalid installed authority fails closed.

The protected launcher must install `/etc/lyrashield/runtime-authority.json` only
following successful complete runtime acceptance. It is an envelope with `raw` and
`result`; `result` uses the existing managed RSA qualification key. The canonical
signed body uses schema `lyrashield-installed-runtime-authority/1`, purpose
`launch-qualified-controller`, the exact source/image/migration/policy tuple,
`epochId`, `epoch`, `acceptanceDigest`, protected `issuer` identity,
`sandboxGrantSigner` delegation, a signed `toolChannel`, and a finite positive
Unix-second `issuedAt`. The installed record is an immutable deployment/epoch
identity and has no action-lease expiry. The current persisted
epoch must be open during observation and every action. Per-attempt grants and
promotion action leases remain bounded to fifteen minutes; their invocation
authority requires the actual database fence. Bounded inventory and closed
rehearsal records cannot substitute for this authority. No such producer or installed envelope is
provided by this change.

The issuer identity binds the product repository/owner, exact product source,
protected `.github/workflows/issue-runtime-qualification.yml` and run/attempt.
The delegated signer uses schema `lyrashield-sandbox-grant-signer/1`, purpose
`sandbox-tool-grants`, `RS256`, an exact key identifier, the same epoch ID/number,
a distinct 3072-bit RSA public JWK and its DER SubjectPublicKeyInfo SHA-256
fingerprint. The observer checks it against root-owned, mode `0400`
`/etc/lyrashield/control/sandbox-grant-key.pem`. That key is never mounted into
worker/engine processes and has no final qualification authority. The host only
verifies the final managed qualification signature; it receives no managed
signing permission. These checks establish neither per-action authority fences
nor future delegation renewal; both need complete runtime integration.

The tool channel uses schema `lyrashield-sandbox-tool-channel/1` and one canonical
HTTPS `origin`: lowercase DNS/IPv4 host, optional nondefault numeric port, no
userinfo, path, query or fragment. The actual worker `TOOL_URL` must equal that
origin. The engine authenticates this public root envelope before sending the
private tool credential, so mutable caller URL input cannot redirect it.

The separately protected `/etc/lyrashield/runtime-policy.json` is bound by its
exact-byte SHA-256 digest. Its schema is `lyrashield-runtime-host-policy/1`; it lists
an internal Docker `network` and four `components`: `broker`, `supervisor`,
`provider-gateway`, and `worker`. Each component records its distinct nonzero
`uid`, `gid`, exact PID-one `processCommand`, nonsecret `environment`, and
`credentialFiles` mapping credential environment names to root-owned files under
`/etc/lyrashield/control`. These are installation policy, never worker input.
The supervisor GID must match the host's `lyrashield-supervisor` socket group;
other roles cannot share it or acquire it through supplementary process groups.
Credentials stay private and are not returned. The actual PID environment, mapped
policy bytes, image configuration and protected credential files must agree.

Observation verifies exact running image IDs, registry digests and OCI sources;
healthy restricted processes; default entrypoints; private internal networking;
protected mounts; no Docker access or worker provider credentials; and the latest
open persisted database epoch through the actual restricted broker connection.
It repeats process, network, policy, authority and epoch observations before
returning bounded hashes. All running containers must belong to the installed
four-component controller while qualification is held.

Disposable tests verify real RSA signatures, Linux filesystem protections, a
retained published sandbox image, and actual restricted process versus root,
writable-root and changed-command launches. They do not qualify the full installed
controller, its paid execution, external journal continuity or restore. Those
require real launcher, issuer, runtime and retained acceptance integration before
release. The new code performs no production installation or deployment.

`createInstalledExecutionAuthorityCapability()` uses fixed protected helper and
managed public-pin paths. It accepts no alternate key, record, purpose or verifier.
Its `verifyAction(connection, action)` authenticates the installed record and
observes the actual policy, images and identities, locks the exact latest open
epoch using the caller's still-held native database gate, and reobserves the same
identity before returning immutable source, epoch and policy hashes. The caller
must bind its approved persisted descriptor to those hashes and retain the gate
through the action. A staging receipt cannot satisfy this production capability.
Missing installed authority or lost observations remain unavailable.
