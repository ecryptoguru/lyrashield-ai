"""Read two connection fingerprints inside one named, live ACA replica."""
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time


def observe():
    group, name, revision, replica, container, nonce = sys.argv[1:]
    if not all(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", arg) for arg in sys.argv[1:]):
        raise ValueError
    if not re.fullmatch("[a-f0-9]{64}", nonce):
        raise ValueError
    # Core Azure CLI's console writer requires a tty, even for a fixed read.
    # Never forward stdin or the raw console transcript to the operator.
    master, slave = pty.openpty()
    proc = None
    try:
        proc = subprocess.Popen(
            ["az", "containerapp", "exec", "--resource-group", group, "--name", name,
             "--revision", revision, "--replica", replica, "--container", container, "--command", "sh"],
            stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        )
        deadline = time.monotonic() + 35
        buf = bytearray()
        sent = False
        marker = ("PAIR_CONN_" + nonce).encode()
        while time.monotonic() < deadline and len(buf) <= 32768:
            if not select.select([master], [], [], 0.25)[0]:
                if proc.poll() is not None:
                    break
                continue
            buf.extend(os.read(master, 4096))
            if not sent and b"Use ctrl + D to exit" in buf:
                # A fixed read. Echoed shell source cannot satisfy the full-line
                # proof because it does not contain the two actual hashes.
                command = (
                    """node -e "const h=k=>require('node:crypto').createHash('sha256').update(process.env[k]).digest('hex');"""
                    + "console.log('PAIR_CONN_" + nonce
                    + """',h('DATABASE_URL'),h('REDIS_URL'))"\nexit\n"""
                )
                os.write(master, command.encode())
                sent = True
            matches = re.findall(rb"(?:^|\n)" + marker + rb" ([a-f0-9]{64}) ([a-f0-9]{64})\r?\n", buf)
            if sent and len(matches) == 1:
                print(b" ".join(matches[0]).decode())
                return
        raise ValueError
    finally:
        if proc is not None:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=2)
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    try:
        observe()
    except (OSError, ValueError, subprocess.SubprocessError):
        sys.exit("Live replica connection proof unavailable")
