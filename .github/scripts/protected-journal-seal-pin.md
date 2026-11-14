# Protected journal checkpoint pin

`createInstalledJournalSealPinStore()` uses the existing R2 conditional transport
in a separate private control bucket. The root controller owns its bucket-scoped
credential. Worker, journal and backup/restore credentials must have no access to
that bucket. It stores one fixed current object per installed epoch/supervisor.
The host receives only the managed qualification **public** key; checkpoint
records use the existing narrow checkpoint HMAC key.

The native loader authenticates `/etc/lyrashield/runtime-authority.json` using
the managed public pin, then checks the exact protected runtime policy digest.
The signed policy's `journalSealControl` has these exact fields:

```text
schema = lyrashield-journal-seal-control/1
productRevision, epochId, epoch, streamId, supervisorInstanceId
originalKeyHash, wrapperKeyHash, checkpointKeyHash
controlAccountId, controlBucket, controlCredentialId
genesisRecordHash, databaseRole
```

Root-owned installation files are fixed. The helper and public key live under
`/opt/lyrashield/runtime-control/`; credentials live under
`/etc/lyrashield/control/` with root ownership, one link and mode `0400`:

- `journal-seal-control-storage.json`: strict schema
  `lyrashield-root-control-r2-storage/1`, `accountId`, `bucket`, `accessKeyId` and
  `secretAccessKey`. The token identity and namespace must match the signed policy.
- `journal-seal-checkpoint-key.txt`: exact existing checkpoint key bytes whose
  hash is pinned by the signed policy.

Every read or advance uses native session serialization, exact latest open epoch
and installed stream row locks, and a separately restricted SQL login. Its
prerequisite check grants nothing. The role can select the two metadata tables
and update only their `updatedAt` columns, which permit PostgreSQL row locks; it
cannot change epoch authority, stream identities, fingerprints or journal data.
Connection loss and deadline expiry prevent subsequent CAS invocation and leave
an in-flight update uncertain. A retry reobserves only the original pin; a newer
pin cannot acknowledge an earlier update.

Advancement derives every field from independently read authenticated seal,
observed acknowledgements and current PostgreSQL/R2 heads. The conditional write
compares the exact current object's ETag, signed contents, parent and continuous
sequence/hash bindings. Successful writes require readback. Concurrent siblings
cannot both commit against the same parent.

A readable pin additionally requires its exact root-control observed-CAS
acknowledgement. The controller creates that narrow HMAC record only after a
positive conditional-write response while its native gate remains active. A late
commit after connection loss has no acknowledgement and stays unavailable.
`retryPending(stream, sealHash)` revalidates the original evidence and conditionally
replays the exact stored envelope under current authority before acknowledging it;
a matching head alone cannot confirm it.

A missing current object is unavailable. `null` means an authenticated
commissioning seed whose exact digest is pinned by the installed policy, rather
than an HTTP 404. Routine operation never creates or restores that seed. Protected
commissioning remains part of the launcher/qualification integration.

Backup and restore preserve the active control bucket. Restoring product
PostgreSQL or journal R2 history cannot roll its pin back. Older restored history
fails comparison with the retained control pin. Loss of the control object
requires a fresh qualified epoch and commissioning; replaying an old seed does
not constitute recovery. This boundary does not promise survival of a compromised
root controller or control-store administrator.

The actual R2 transport proofs used owned disposable prefixes in the existing
evidence bucket and the separate private control bucket, then removed them.
The control-only credential was also denied a journal-bucket read. These prove
conditional-write and credential separation without creating production control
authority. Linux RSA/filesystem checks and real
PostgreSQL role/lock/revocation tests cover the loader and gate separately. The
PostgreSQL test uses a source-loader fixture. Full installed controller acceptance,
root qualification, bucket-scoped credential installation and commissioning are
not established by these tests.

`withBoundedContinuation(stream, callback)` holds the qualified stream gate while
confirming the exact pin, observed control CAS acknowledgement and immutable v2
seal. A newer current journal head is only an input to the callback's complete
local and independent-mirror tail proof. The callback must verify ancestry and
the trusted recovery fold before making an authority decision; it can check the
same gate with `assertActive`. A v1 seal cannot qualify continuation. The pin is
rechecked before the held callback completes, and `assertEvidenceReader` rejects
a different reader instance. Publication keeps its stricter seal-time current
head requirement.
