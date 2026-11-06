"""Task-owned loopback-only relay to a disposable Docker PostgreSQL process."""

import os
import socket
import subprocess
import sys
import threading

container, port_file = sys.argv[1:3]
stop_file = sys.argv[3] if len(sys.argv) > 3 else None
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(32)
if stop_file:
    listener.settimeout(0.2)
with open(port_file, "x", encoding="ascii") as output:
    output.write(str(listener.getsockname()[1]))


def relay(connection):
    process = subprocess.Popen(
        ["docker", "exec", "-i", container, "nc", "127.0.0.1", "5432"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    def to_database():
        try:
            while data := connection.recv(65536):
                process.stdin.write(data)
                process.stdin.flush()
        except (OSError, BrokenPipeError):
            pass
        finally:
            process.stdin.close()

    def to_client():
        try:
            while data := os.read(process.stdout.fileno(), 65536):
                connection.sendall(data)
        except OSError:
            pass
        finally:
            connection.close()

    send = threading.Thread(target=to_database, daemon=True)
    send.start()
    to_client()
    process.terminate()
    process.wait()


while True:
    if stop_file and os.path.exists(stop_file):
        break
    try:
        client, _ = listener.accept()
    except socket.timeout:
        continue
    threading.Thread(target=relay, args=(client,), daemon=True).start()
listener.close()
