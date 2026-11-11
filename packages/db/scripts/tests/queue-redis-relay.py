"""Owned loopback-only Redis relay; the fixture supplies a network-none container."""
import os
import socket
import subprocess
import sys
import threading

container, port_file = sys.argv[1:]
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(32)
with open(port_file, "x", encoding="ascii") as output:
    output.write(str(listener.getsockname()[1]))


def relay(connection):
    process = subprocess.Popen(
        ["docker", "exec", "-i", container, "nc", "127.0.0.1", "6379"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )

    def send():
        try:
            while data := connection.recv(65536):
                process.stdin.write(data)
                process.stdin.flush()
        except (OSError, BrokenPipeError):
            pass
        finally:
            process.stdin.close()

    threading.Thread(target=send, daemon=True).start()
    try:
        while data := os.read(process.stdout.fileno(), 65536):
            connection.sendall(data)
    except OSError:
        pass
    finally:
        connection.close()
        process.terminate()
        process.wait()


while True:
    client, _ = listener.accept()
    threading.Thread(target=relay, args=(client,), daemon=True).start()
