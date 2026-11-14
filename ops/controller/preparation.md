# Protected repository preparation

Production preparation requires a managed-qualified runtime policy with schema
`lyrashield-runtime-host-policy/2`. Its `preparation` field is the strict
`lyrashield-preparation-delegation/1` record: a dedicated RSA-3072 public key,
`scan-preparation` purpose, exact product revision and authority epoch,
`REPO` target scope, `REVIEW_TARGET` / `REVIEW_CHANGES` workflows, expiry within
24 hours, and a maximum staging lifetime of 15 minutes. The public key and
preparation-policy checksum are covered by the qualified runtime-policy digest.
The root preparation key must differ from the managed qualification and sandbox
signing keys. A v1 policy retains recovery and leaves production preparation closed.

Provision these artifacts through the authenticated release boundary; the host
installer installs committed programs and directories, and creates no delegation:

| Host artifact                                                        | Required protection and binding                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/etc/lyrashield/preparation-host-policy.json`                       | Root `0400`; canonical v2 policy bytes match delegated `preparationPolicyChecksum`.                                                                      |
| `/etc/lyrashield/control/preparation-grant-key.pem`                  | Root `0400`; dedicated private key matching the delegated SPKI hash.                                                                                     |
| `/etc/lyrashield/control/preparation-public-key.pem`                 | Root `0400`; matching dedicated public key.                                                                                                              |
| `/etc/lyrashield/control/broker/preparation-host-policy.public.json` | Root:broker `0440`, parent `0750`; exact canonical policy bytes, mounted read-only at `/opt/lyrashield-runtime/preparation-host-policy.json`.            |
| `/etc/lyrashield/control/broker/preparation-public-key.pub.pem`      | Root:broker `0440`, same parent; matching public key, mounted read-only at `/opt/lyrashield-runtime/preparation-public-key.pem`.                         |
| `/etc/lyrashield/control/preparation-source-database-url.txt`        | Root `0400`; broker credential `LYRASHIELD_PREPARATION_SOURCE_DATABASE_URL`; a separate direct restricted source-reader login on the execution database. |
| `/etc/lyrashield/control/preparation-github.env`                     | Root `0400`; exactly `GITHUB_APP_ID` and single-line `GITHUB_APP_PRIVATE_KEY` with escaped newlines. No role receives this private key.                  |
| `/etc/lyrashield/control/preparation-evidence.env`                   | Root `0400`; approved S3 endpoint/bucket/read credentials and envelope KEK configuration.                                                                |
| `/etc/lyrashield/control/egress/<network-policy-checksum>.json`      | Root `0400`; canonical policy checksum matches the preparation isolation policy.                                                                         |

The qualified broker's public environment binds
`LYRASHIELD_PREPARATION_GITHUB_APP_ID`,
`LYRASHIELD_PREPARATION_GITHUB_KEY_SHA256` (DER SPKI SHA-256), and
`LYRASHIELD_PREPARATION_EVIDENCE_CONFIG_SHA256` (exact evidence environment bytes).
The evidence environment permits only `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY`, `LYRASHIELD_EVIDENCE_KEK`,
`LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF`, and `LYRASHIELD_EVIDENCE_KEK_KEYRING`.
Its endpoint must use HTTPS. Shared SDK configuration comes from the measured
broker; the SDK database credential is the restricted source-reader credential.
The root download helper uses no mail/auth admission flows or model credentials.

The source-reader login must inherit `lyrashield_preparation_source_reader` without
SET-role access. It cannot bypass RLS, perform DDL, mutate rows/columns, or invoke
unrelated definers. Broker startup verifies this contract before opening admission.
The PREPARE login also needs scoped `ScanAttachment` SELECT and must have no
attachment mutation privileges.

The broker's fixed preparation socket maps
`/run/lyrashield/control/preparation.sock` to
`/opt/lyrashield-runtime/preparation.sock`, read-only, root:broker `0660`.
Before the PREPARE gate, the root issuer rechecks the current assigned worker,
workspace membership, delegation, active GitHub integration and exact persisted
execution-plan hash. It obtains a repository-specific contents-read token and
downloads approved encrypted attachments through the existing SDK. All network
work occurs outside database authority transactions.

Acquisition uses the measured broker image's read-only Node/dependency closure.
A fixed root subprocess temporarily selects its held mount namespace to clone
its held image root, returns to the host namespace, and installs the detached
image and root-only host-resolver snapshot in a private mount namespace. It
retains the host network and changes no controller mount/network. It then chroots
and drops all Linux capabilities, locks privilege regain, and executes only the
fixed download entrypoint. This requires Linux 5.2 or newer on x86-64 or arm64,
root namespace setup capability, Python 3 with Linux FD support, and `prlimit`.
The issuer service bounds memory to 1 GiB and allows no swap; each download has a
45-second deadline, a bounded Node heap, and bounded private-pipe output.

Only exact pinned Git revisions enter the root source grant. Comparison history
must prove the recorded merge base; branch HEAD never substitutes for a missing
pin. Root-owned immutable input trees include hidden files, ignored tracked
files, `.git`, and empty directories. The D/F binary digest matches the engine
format and rejects links, special files, cross-device inputs and races. Attachment
bytes must match persisted workspace, checksum, envelope key reference and length.

Inside PREPARE, the issuer binds the immutable staged record and catalog to the
new attempt. The compiler compares current scoped attachment metadata and the
signed record. After the exact PREPARE command is inserted, the installed native
capability verifies that persisted command on the same gated transaction before
commit. The supervisor rehashes every protected source and attachment byte before
mounting; installed roots remain root-owned and immutable. Missing or changed
source, authority, key, catalog or credentials keep execution closed.

Disposable Linux tests exercise actual source bytes, RSA signatures, catalog
bindings, namespace isolation and capability removal. PostgreSQL fixtures exercise
source-reader privileges, current worker assignment, approved attachments,
revocation, epoch retirement and schema drift. These fixtures establish code
behavior; they do not issue a managed production qualification or prove a live
rollout.
