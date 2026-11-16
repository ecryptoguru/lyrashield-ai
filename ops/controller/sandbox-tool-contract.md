# Guarded sandbox tool contract

The supervisor calls the installed root executor over its protected Unix socket. It has no Docker socket. Every effect binds an immutable action intent, native invocation guard, accepted scan attempt, workspace, account, current worker grant, epoch and original started sandbox ownership. The root executor derives image, network and command from that stored authority.

The engine receives a signed capability for its exact attempt and sandbox. Its expiry is clamped to the accepted runtime deadline, with a maximum of 45 minutes for the retained REPO profiles. A signature alone does not authorize an effect: intent publication and native invocation recheck current authority. The separately signed SDK state grant lasts at most 15 minutes. A state refresh creates a fresh guarded fixed `/usr/bin/true` execution, records its native acknowledgement and returns only the root signer's newly verified grant. Stopped sandboxes return actual `running:false` without renewal. Missing installation or qualification evidence keeps admission closed.

| Route                          | Bound                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `POST exec`                    | 300 seconds; 1 MiB combined stdout and stderr                                          |
| `POST pty/start`               | Real Docker TTY/attached stdin; 300 seconds and 1 MiB retained output                  |
| `POST pty/stdin`               | One exact original session; 64 KiB UTF-8 input and single-use mutation guard           |
| `POST pty/terminate`           | Only sessions owned by the original attempt                                            |
| `POST stop`                    | The exact owned sandbox, including zero-session sandboxes; preserves the engine        |
| `GET state`                    | Fresh current authority and signed grant renewal, or actual stopped state              |
| `POST files/read`              | 512 KiB complete file; regular files beneath `/workspace`                              |
| `POST files/write`             | 64 KiB decoded input with SHA-256                                                      |
| `POST workspace/persist`       | 512 KiB complete archive; at most 1,000 entries                                        |
| `POST workspace/hydrate`       | 64 KiB decoded archive input; at most 512 KiB total expanded content and 1,000 entries |
| `GET port/48080`               | The fixed Caido port on the exact owned sandbox's private scan network                 |
| `POST request/<requestId>/ack` | Exact retained response checksum and original scope                                    |

File access opens every directory component relative to the `/workspace` descriptor with `O_NOFOLLOW`. Writes reject nonregular targets. Archives use uncompressed tar. Hydration validates every entry before writing and rejects absolute paths, traversal, symlinks, hard links and special files. Persisting a capped, unreadable or unsupported entry fails without returning partial bytes as a complete archive. SDK size defaults are upper bounds; the server limits above apply.

A qualified sandbox image must contain Python 3 and `/usr/bin/timeout` with the installed termination behavior. The root actor durably records the exact exec ID before starting it and returns a bounded start acknowledgement. Its background runner captures output within the immutable limit. Exec timeout, overflow or native uncertainty stops the entire owned sandbox, including detached descendants. PTY execution first isolates the stopped exec wrapper in a private cgroup before user code runs; timeout, overflow and session termination kill that exact session's descendants and verify the cgroup is empty. If isolation or quietness cannot be established, the root actor stops the owned sandbox. Uncertainty remains `UNKNOWN` and is never replayed as a new execution.

Successful terminal bytes are retained in the private root ledger before observation. The supervisor verifies their scope, checksum and output bound, encrypts the exact response, and confirms its independent tool journal mirror before returning it. Retries return that same retained response. A lost acknowledgement or uncertain native start does not authorize another exec. PTY input and termination record the original session/exec targets, immutable root mutation identity and checksum; they never label a reused session as a fresh exec. The main signed start acknowledgement updates the supervisor's in-memory guard state immediately without joining a lifecycle queue that may be waiting for the held native gate.

When the initial native acknowledgement is lost, the pending tool guard remains unresolved. Full lifecycle cleanup may retire it only after the root executor verifies that the exact owned sandbox is absent and binds that observation to the stored STOP command. The root ledger records a single-use retirement tombstone, and the independently authenticated main journal resolves the guard with a retirement proof. This does not invent an execution acknowledgement or replay the tool.

Local Docker regression tests cover real execution, timeout with detached descendants, overflow, ownership rejection, file/archive round trips, unsafe paths and incomplete capped content. These disposable tests establish bounded behavior for their tested image; they do not qualify an installed production image or authorize promotion.
