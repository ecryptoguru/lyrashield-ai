"""Wall-time and Docker-VM space guards for the isolated evidence drill."""

import argparse
import os
import re
import signal
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path


def space(df):
    rows = df.splitlines()
    fields = rows[-1].split() if len(rows) == 2 else []
    if (
        len(fields) != 6
        or fields[-1] != "/"
        or fields[0] in {"tmpfs", "devtmpfs", "ramfs"}
        or not re.fullmatch(r"[0-9]+", fields[3])
    ):
        raise ValueError("cannot establish Docker-VM root filesystem free space")
    available = int(fields[3])
    if available < 5 * 1024 * 1024:
        raise ValueError(
            f"Docker-VM free space {available} KiB below required 5 GiB after image preload"
        )
    print(f"Docker-VM root has {available} KiB free after image preload", flush=True)


def cleanup(prefix):
    # Bounded, label-isolated cleanup also runs when the inner shell or docker CLI timed out.
    errors = []
    selector = "label=lyrashield.evidence-drill=" + prefix
    for kind, find, remove in [
        ("container", ["ps", "-aq"], ["rm", "-fv"]),
        ("network", ["network", "ls", "-q"], ["network", "rm"]),
    ]:

        def listed():
            return subprocess.run(
                ["docker", *find, "--filter", selector],
                check=True,
                text=True,
                capture_output=True,
                timeout=10,
            ).stdout.split()

        try:
            ids = listed()
            if ids:
                subprocess.run(["docker", *remove, *ids], check=True, timeout=15)
            if listed():
                raise RuntimeError("still present")
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            errors.append(f"{kind}: {error}")
    if errors:
        raise RuntimeError(
            f"fixture cleanup incomplete for {prefix}: " + "; ".join(errors)
        )


def supervise(script, fixtures, *selection, timeout=600):
    with tempfile.TemporaryDirectory(prefix="reader-evidence-drill-") as temp:
        scratch = str(Path(temp).resolve())
        prefix = "lyra-ed-" + uuid.uuid4().hex[:16]
        env = {**os.environ, "LYRA_DRILL_SCRATCH": scratch, "LYRA_DRILL_PREFIX": prefix}
        child = subprocess.Popen(
            ["bash", script, "--supervised", "--fixtures", fixtures, *selection],
            env=env,
            start_new_session=True,
        )

        def interrupted(_signum, _frame):
            raise KeyboardInterrupt()

        previous = signal.signal(signal.SIGTERM, interrupted)
        try:
            return child.wait(timeout=timeout)
        finally:
            signal.signal(signal.SIGTERM, previous)
            # Kill the isolated process group, including any still-running host docker CLI.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            if Path(scratch, "docker-resources").exists():
                cleanup(prefix)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["supervise", "bounded", "space"])
    parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.mode == "space":
        space(sys.stdin.read(2048))
    elif args.mode == "bounded":
        seconds, *cmd = args.args
        # Inherit the supervisor's process group. subprocess.run kills and waits for
        # the CLI on phase expiry; the outer finally removes its daemon-side resources.
        try:
            sys.exit(subprocess.run(cmd, timeout=int(seconds)).returncode)
        except subprocess.TimeoutExpired:
            # Docker argv contains disposable credentials; do not echo it in timeout errors.
            print(f"fixture phase command exceeded {seconds}s", file=sys.stderr)
            sys.exit(124)
    else:
        script, fixtures, *selection = args.args
        try:
            sys.exit(supervise(script, fixtures, *selection))
        except subprocess.TimeoutExpired:
            print(
                "whole disposable drill exceeded its wall-clock deadline",
                file=sys.stderr,
            )
            sys.exit(124)
