"""Loopback PostgreSQL relay that can discard one matching COMMIT response."""

import os
import socket
import struct
import subprocess
import sys
import threading
import time

container, port_file, arm, marker, delay_arm, delay_marker, live_delay_arm, live_delay_marker, live_stall_arm, live_stall_marker = sys.argv[1:]
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(64)
with open(port_file, "x", encoding="ascii") as output:
    output.write(str(listener.getsockname()[1]))
fired = threading.Event()
projection_fired = threading.Event()
stage_fired = threading.Event()
delayed = threading.Event()
live_delayed = threading.Event()
live_stalled = threading.Event()
fired_lock = threading.Lock()


def read_exact(stream, length):
    chunks = bytearray()
    while len(chunks) < length:
        chunk = os.read(stream.fileno(), length - len(chunks))
        if not chunk:
            raise EOFError
        chunks.extend(chunk)
    return bytes(chunks)


def recv_exact(connection, length):
    chunks = bytearray()
    while len(chunks) < length:
        chunk = connection.recv(length - len(chunks))
        if not chunk:
            raise EOFError
        chunks.extend(chunk)
    return bytes(chunks)


def relay(connection):
    process = None
    try:
        startup_header = recv_exact(connection, 4)
        startup_length = struct.unpack("!I", startup_header)[0]
        if startup_length < 8 or startup_length > 8192:
            raise ValueError("invalid startup frame")
        startup = recv_exact(connection, startup_length - 4)
        if startup[:4] != b"\x00\x03\x00\x00":
            raise ValueError("fixture requires plaintext PostgreSQL startup")
        raw = startup[4:]
        if not raw.endswith(b"\x00\x00"):
            raise ValueError("invalid startup terminator")
        parts = raw[:-2].split(b"\x00")
        if not parts or len(parts) % 2:
            raise ValueError("invalid startup parameters")
        fields = dict(zip(parts[::2], parts[1::2]))
        if len(fields) * 2 != len(parts):
            raise ValueError("duplicate startup parameter")
        target = fields.get(b"user") in (b"postgres", b"dispatch_prepare_broker", b"dispatch_receipt_consumer")

        process = subprocess.Popen(
            ["docker", "exec", "-i", container, "nc", "127.0.0.1", "5432"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        process.stdin.write(startup_header + startup)
        process.stdin.flush()

        transaction = {"begin": False, "attempt_insert": False, "receipt_insert": False, "stage_insert": False, "liveness": False}
        transaction_lock = threading.Lock()

        def to_database():
            try:
                while True:
                    header = recv_exact(connection, 5)
                    length = struct.unpack("!I", header[1:])[0]
                    if length < 4 or length > 16 * 1024 * 1024:
                        raise ValueError("invalid frontend frame")
                    body = recv_exact(connection, length - 4)
                    sql = b""
                    if header[:1] == b"Q":
                        sql = body.split(b"\x00", 1)[0]
                    elif header[:1] == b"P":
                        parts = body.split(b"\x00", 2)
                        if len(parts) == 3:
                            sql = parts[1]
                    normalized = sql.upper()
                    with transaction_lock:
                        if normalized.lstrip().startswith(b"BEGIN"):
                            transaction.update(begin=True, attempt_insert=False, receipt_insert=False, stage_insert=False)
                        elif transaction["begin"] and normalized.lstrip().startswith(b"INSERT"):
                            if b'"SCANDISPATCHATTEMPT"' in normalized or (fields.get(b"user") == b"dispatch_receipt_consumer" and b'"SCANSUPERVISORJOURNALRECORD"' in normalized):
                                transaction["attempt_insert"] = True
                            if fields.get(b"user") == b"dispatch_receipt_consumer" and b'"SCANSUPERVISORRECEIPT"' in normalized:
                                transaction["receipt_insert"] = True
                            if fields.get(b"user") == b"dispatch_start_stage" and b'"SCANDISPATCHSTART"' in normalized:
                                transaction["stage_insert"] = True
                    with transaction_lock:
                        if not transaction["begin"] and b"CLOCK_TIMESTAMP()" in normalized and normalized.endswith(b" AS LIVE"):
                            transaction["liveness"] = True
                    process.stdin.write(header + body)
                    process.stdin.flush()
            except (EOFError, OSError, ValueError):
                pass
            finally:
                try:
                    process.stdin.close()
                except OSError:
                    pass

        threading.Thread(target=to_database, daemon=True).start()
        while True:
            header = read_exact(process.stdout, 5)
            length = struct.unpack("!I", header[1:])[0]
            if length < 4 or length > 16 * 1024 * 1024:
                raise ValueError("invalid PostgreSQL frame")
            body = read_exact(process.stdout, length - 4)
            if header[:1] == b"D":
                with transaction_lock:
                    is_live_query = target and transaction["liveness"]
                    transaction["liveness"] = False
                if is_live_query:
                    with fired_lock:
                        delay = os.path.isfile(live_delay_arm) and not live_delayed.is_set()
                        stall = os.path.isfile(live_stall_arm) and not live_stalled.is_set()
                        if delay: live_delayed.set()
                        elif stall: live_stalled.set()
                    if delay or stall:
                        selected_marker = live_delay_marker if delay else live_stall_marker
                        with open(selected_marker, "x", encoding="ascii") as output:
                            output.write("live=true\n" if body.endswith(b"t") else "live=false\n")
                        time.sleep(4 if delay else 8)
                        if stall: return
            if header[:1] == b"C" and body == b"COMMIT\x00":
                with transaction_lock:
                    matches = target and transaction["begin"] and transaction["attempt_insert"]
                    stage_matches = transaction["begin"] and transaction["stage_insert"]
                if stage_matches and os.path.isfile(arm + ".stage"):
                    with fired_lock:
                        drop_stage = not stage_fired.is_set()
                        if drop_stage:
                            stage_fired.set()
                    if drop_stage:
                        with open(marker + ".stage", "x", encoding="ascii") as output:
                            output.write("dispatch-billing-stage-commit-response-dropped\n")
                        return
                if target and transaction["receipt_insert"] and os.path.isfile(arm + ".projection"):
                    with fired_lock:
                        should_drop_projection = not projection_fired.is_set()
                        if should_drop_projection:
                            projection_fired.set()
                    if should_drop_projection:
                        with open(marker + ".projection", "x", encoding="ascii") as output:
                            output.write("receipt-projection-commit-response-dropped\n")
                        return
                if os.path.isfile(arm):
                    print(
                        f"commit_observed target={int(target)} matches={int(matches)} fired={int(fired.is_set())}",
                        file=sys.stderr,
                        flush=True,
                    )
                if matches and os.path.isfile(arm):
                    with fired_lock:
                        should_drop = not fired.is_set()
                        if should_drop:
                            fired.set()
                    if should_drop:
                        with open(marker, "x", encoding="ascii") as output:
                            output.write("dispatch-prepare-commit-response-dropped\n")
                        return
                if matches and os.path.isfile(delay_arm) and not delayed.is_set():
                    delayed.set()
                    with open(delay_marker, "x", encoding="ascii") as output:
                        output.write("dispatch-prepare-commit-response-delayed\n")
                    time.sleep(10.2)
            if header[:1] == b"C" and body in (b"COMMIT\x00", b"ROLLBACK\x00"):
                with transaction_lock:
                    transaction.update(begin=False, attempt_insert=False, stage_insert=False)
            connection.sendall(header + body)
    except (EOFError, OSError, ValueError):
        pass
    finally:
        try:
            connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        connection.close()
        if process is not None:
            process.terminate()
            process.wait()


while True:
    client, _ = listener.accept()
    threading.Thread(target=relay, args=(client,), daemon=True).start()
