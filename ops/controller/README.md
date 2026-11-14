# Protected controller host installation

After the release caller qualifies an exact merged product revision and provisions
the managed public pin at
`/opt/lyrashield/runtime-control/runtime-qualification-key.json`, install the
protected host boundary from that checkout:

```sh
sudo /bin/bash ops/controller/install-controller-host.sh <exact-product-revision>
```

The installer reads committed Git blobs, verifies protected parent directories,
and installs the root services and fixed sockets. The supervisor uses
`/run/lyrashield/control/authority.sock`; the broker uses
`/run/lyrashield/control/broker-authority.sock`; the worker uses
`/run/lyrashield/control/worker-authority.sock`. All three primary groups are distinct.
The native executor uses `/run/lyrashield/control/native-executor.sock`, accessible
only to the supervisor group, and a root-only ledger at
`/var/lib/lyrashield/native-executor`. Its credentials come separately from the
root-owned mode `0400` file `/etc/lyrashield/native-executor.env`; the installer
never writes that file or any signing authority. Missing credentials keep native
effects closed. Active units must be stopped through the release drain before an
update. Every successful operation still requires the independently signed runtime
authority and its live host checks.

The preparation issuer uses `/run/lyrashield/control/preparation.sock`, accessible
only to the broker group. Its source catalog, grant records and resource catalog
use private root directories. The installer creates those directories and installs
the issuer; qualified preparation policy, signer, public copies and egress policy
must be provisioned separately. Missing delegation keeps issuance unavailable.

The worker endpoint accepts only `worker-execution-authority`. Its fixed root helper
checks the signed installed image/policy, kernel peer identity, protected worker
configuration and current private database grant. Provision
`/etc/lyrashield/control/worker-authority.json` as root:worker `0440`, with the
`lyrashield-worker-broker-installation/1` schema and stable authority fields
`productRevision`, `workerImageDigest`, `engineRevision`, `authorityEpochId`, `epoch`,
`workerInstanceId`, `workerGrantId` and `expiresAt`, plus its private `workerCredential`.
Bind its complete SHA-256 to the signed worker policy environment's
`LYRASHIELD_WORKER_INSTALLATION_CHECKSUM`. Mount the configuration and worker socket
read-only at their fixed `/opt/lyrashield-runtime` paths. The distinct root `0400`
file `/etc/lyrashield/worker-observer.env` supplies only
`WORKER_OBSERVER_DATABASE_URL`, using the restricted direct
`app_native_origin_reader` login on the authoritative database. The installer
provisions neither grants nor credentials. Missing configuration leaves worker
admission closed before consumer or provider startup.

The same worker-only socket accepts two bounded JSON requests: inventory of its
current assigned operations, and a result proof for one operation. The root helper
rechecks the private worker grant and database assignment before returning the
original native action, ownership and SHA-256 of a cached output bundle. Native
capture uses a derived root-owned attempt directory before engine STOP, the five
fixed engine artifacts, and the immutable staged source. Missing, unreadable or
capped files remain explicit; they never become empty completed results. The
canonical bundle is bounded to 96 MiB and transferred in chunks of at most 1 MiB.
The worker verifies the complete bundle against its direct root-socket proof
before parsing engine evidence or scanning the reconstructed source.

The supervisor observation socket also accepts the fixed
`disposable-execution-authority` request. It verifies a separate finite Linux test
capability, its protected boot/run/nonce scope and the actual supervisor peer and
returns `disposable-installed`. The broker endpoint rejects that request, and the
production observation request retains its production authority verifier.

Run the isolated Linux installer, ownership and socket tests with:

```sh
LYRASHIELD_HOST_INSTALL_TEST=1 python3 ops/controller/tests/install-controller-host.test.py
python3 ops/controller/authority-observer.test.py
python3 ops/controller/disposable-observation.test.py
```

The installer tests use a disposable public pin and mocked systemd control while
validating the actual units and root socket processes. They establish installation
and rejection behavior, not production execution qualification.

## Isolated closed candidate smoke

The candidate uses a new Docker-in-Docker daemon with `--network none`. It binds no
host Docker socket to any of the four runtime roles. Provide a private, single-link
input file owned by the calling user, mode `0600` or `0400`, then run:

```sh
python3 ops/controller/run-disposable-candidate.py /absolute/path/to/private-input.json
```

The exact input schema is `lyrashield-disposable-candidate-input/1`. Fields are
`owner` (positive job run and attempt, `run:attempt`), `sourceRevision`, `sourceTree`,
`engineRevision` (each 40 lowercase hexadecimal characters), `images` and
`infrastructure`. The image map requires exactly `broker`, `supervisor`,
`provider-gateway`, `worker`, `database`, `redis`, `provider`, `sandbox` and `host`.
Infrastructure requires exactly `dind` and `registry`. Every reference must be an
already available immutable image ID (`sha256:...`) or digest reference. The four
runtime images and host image must carry the exact source revision and canonical
repository OCI labels. Build the host from the `disposable-controller-fixture`
Docker target on the same immutable source. This lane accepts a committed branch
source; production installation separately requires qualified merged source.

The runner round-trips images through a temporary local registry, applies genuine
PostgreSQL migrations, creates restricted fixture roles, closes Redis admission,
and starts the four actual images with distinct positive UID/GID identities and
read-only roots. Its dedicated finite RSA pin is bound to the run, boot, nonce,
source tree and exact image tuple. Only after those physical checks does it issue
the distinct disposable capability. It checks the actual supervisor observer peer
and rejects a native request missing its original database guard, confirming the
real read-only guard query and absence of a native ledger object. Cleanup removes
only the nonce-owned isolated composition.

Successful output is `lyrashield-disposable-controller-liveness/1` with admission
`CLOSED`, independent R2 journal `UNQUALIFIED` and native effects `UNMEASURED`.
This smoke does not produce production qualification, paid provider acceptance,
tool capability acceptance or managed installed authority. Those gates require
their genuine protected runtime evidence and remain separate.
