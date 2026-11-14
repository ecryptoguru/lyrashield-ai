# Root journal seal publication

`publish-journal-seal.mjs` publishes an immutable v2 journal seal, its recovery snapshot, and the installed root pin. It returns the actual acknowledged publication hashes for the protected runtime evidence producer. This is an operational entrypoint, not evidence that this branch has been installed or qualified in production.

Run it only from the exact source dependency closure staged and verified by the protected root launcher, after draining the supervisor. The journal files retain their existing exclusive writer locks. Routine publication never installs authority, creates genesis, edits historical records, or opens admissions.

The protected launcher invokes this command as root inside the signed, digest-pinned supervisor image with its root filesystem read-only:

```sh
node --import tsx /app/src/publish-journal-seal.mjs <product-revision>
```

The image uses the existing supervisor production dependency closure. The publisher and native host query files are root-owned and read-only; the normal supervisor process retains its non-root user. The publisher checks its fixed deployed path, root filesystem mount, and root source ownership. The host launcher independently verifies the actual image digest against the signed installed supervisor policy. A writable container or a mutable workspace cannot publish a seal. The Python signature verifier needs a private writable temporary directory; this does not require a Docker socket in the publisher container.

The optional second argument is an actual retained pending seal hash. A partial publication returns `UNKNOWN` and that hash; retry the same selector. If the current head is already sealed, the publisher reobserves the acknowledged pin. It seals longer confirmed histories in bounded segments before returning an exact-head observation. Existing journal and recovery snapshot capacity limits remain enforced.

The publisher reads these fixed files. Their ancestors must be root directories without group or other write permissions; each file must be root:root, mode `0400`, a regular file with one link, and unchanged while read.

- `/etc/lyrashield/control/journal-seal-publisher.json`
- `/etc/lyrashield/control/journal-seal-control-storage.json`
- `/etc/lyrashield/control/journal-seal-checkpoint-key.txt`

The publisher configuration has exactly `schema`, `productRevision`, `environment`, `sealDatabaseUrl`, and `mirrorDatabaseUrl`. Its schema is `lyrashield-root-journal-seal-publisher/1`. `environment` supplies the exact protected supervisor journal, authority, source, gateway and cgroup fields listed in `parseRootPublicationConfiguration`; process loader variables and arbitrary environment overrides are rejected. Do not add this credential-bearing configuration to Git or evidence artifacts.

All four PostgreSQL login identities must differ: supervisor execution, supervisor journal mirror, root seal control, and root seal mirror. The root control and execution URLs must address the same database with matching connection options; both mirror URLs must address the same mirror store. The seal control role must match the signed installed control policy and its existing restricted epoch/stream prerequisites. The seal mirror may execute only the existing head/seal read functions and `append_seal`; it cannot append journal records, access application tables, create database/schema objects, escalate roles, or invoke unrelated security-definer functions. Provision those identities separately before installation. The root control R2 account/bucket/credential must match the signed installed policy and use a namespace and credential distinct from the supervisor journal.

The root publication fence takes the native action session lock, retains the exact installed epoch/stream row locks, and reobserves the installed policy through publication. The nested root pin uses its separate control lock. Original records, wrappers, remote records, PostgreSQL originals, native invocation facts and observed journal ACKs are independently checked by the installed journal loader before sealing. Snapshot folding uses that authenticated publication context and rechecks its unchanged source bytes.

Successful output uses `lyrashield-root-journal-seal-publication/1` and includes `source`, the seal/snapshot/pin and observed ACK hashes, identical R2/PostgreSQL head hashes, and the exact positive sequence. The protected root qualification producer binds its run owner and complete canonical fleet hash to those actual fields, then writes the accepted `lyrashield-runtime-journal-evidence/1` artifact to the existing root-owned evidence transport. The intermediate publication observation alone is not a fleet qualification ticket.

Local boundary checks:

```sh
pnpm exec vitest run ops/controller/tests/journal-seal-publication.test.ts
pnpm exec eslint ops/controller/journal-seal-publication.mjs ops/controller/publish-journal-seal.mjs ops/controller/tests/journal-seal-publication.test.ts --max-warnings 0
```

The restricted PostgreSQL journal harness tests real persisted authority and snapshot folding; its remote transport remains an owned synthetic fixture. Protected Linux installation, actual remote publication and hosted runtime qualification require their separate observed evidence.

The same root publisher seals the derived sandbox tool stream with `node --import tsx /app/src/publish-journal-seal.mjs <product-revision> --tools [retained-seal-hash]`. It requires separately installed `tool-journal-seal-publisher.json`, `tool-journal-seal-control-storage.json`, and `tool-journal-seal-checkpoint-key.txt` under `/etc/lyrashield/control`, with the same root-only file checks. The signed supervisor environment must contain public `LYRASHIELD_TOOL_JOURNAL_SEAL_CONTROL_JSON`; its stream and supervisor identities end in `.tools`, and its checkpoint, key hashes, control credential and control namespace differ from the controller policy. The loader derives tool signing keys privately and checks the exact registered hashes. Tool snapshots retain their authenticated tool originals and use `lyrashield-supervisor-tool-recovery-snapshot/1`. This path does not provision keys, stream metadata, or accepted runtime evidence.
