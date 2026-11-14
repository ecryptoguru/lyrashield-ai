"""Exercise private input and exact immutable fixture preflight boundaries."""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "candidate", Path(__file__).with_name("run-disposable-candidate.py")
)
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateInputTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "input.json"
        self.value = {
            "schema": "lyrashield-disposable-candidate-input/1",
            "owner": "123:1",
            "sourceRevision": "a" * 40,
            "sourceTree": "b" * 40,
            "engineRevision": "c" * 40,
            "images": {role: "sha256:" + "d" * 64 for role in candidate.ROLES},
            "infrastructure": {
                role: "sha256:" + "e" * 64 for role in ("dind", "registry")
            },
        }
        self.write()

    def tearDown(self):
        self.temporary.cleanup()

    def write(self):
        self.path.write_text(json.dumps(self.value))
        self.path.chmod(0o600)

    def docker(self, *args):
        if args == ("context", "show"):
            return "desktop-linux"
        if args[0] == "context":
            return "unix:///fixture/docker.sock"
        return json.dumps(
            [
                {
                    "Config": {
                        "Labels": {
                            "org.opencontainers.image.revision": self.value[
                                "sourceRevision"
                            ],
                            "org.opencontainers.image.source": "https://github.com/ecryptoguru/lyrashield-ai",
                            "com.lyrashield.engine.revision": self.value[
                                "engineRevision"
                            ],
                        }
                    }
                }
            ]
        )

    def test_accepts_only_exact_private_immutable_input(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(candidate, "docker", side_effect=self.docker),
        ):
            self.assertEqual(candidate.load_input(self.path), self.value)
            for change in ("extra", "mutable", "wrong-role", "wrong-owner"):
                original = json.loads(json.dumps(self.value))
                if change == "extra":
                    self.value["unsafe"] = True
                if change == "mutable":
                    self.value["images"]["worker"] = "worker:latest"
                if change == "wrong-role":
                    self.value["images"]["web"] = self.value["images"].pop("worker")
                if change == "wrong-owner":
                    self.value["owner"] = "0:1"
                self.write()
                with self.assertRaises(RuntimeError):
                    candidate.load_input(self.path)
                self.value = original
                self.write()

    def test_rejects_symlink_hardlink_permissions_and_remote_docker(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(candidate, "docker", side_effect=self.docker),
        ):
            self.path.chmod(0o644)
            with self.assertRaises(RuntimeError):
                candidate.load_input(self.path)
            self.path.chmod(0o600)
            alias = self.path.with_suffix(".alias")
            os.link(self.path, alias)
            with self.assertRaises(RuntimeError):
                candidate.load_input(self.path)
            alias.unlink()
            alias.symlink_to(self.path)
            with self.assertRaises(OSError):
                candidate.load_input(alias)
            with (
                patch.dict(os.environ, {"DOCKER_HOST": "tcp://example.invalid:2375"}),
                self.assertRaises(RuntimeError),
            ):
                candidate.load_input(self.path)


class CandidateImageTransferTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.cli = Path(self.temporary.name) / "docker"
        self.cli.write_text(
            "#!/usr/bin/env python3\n"
            "import os,sys,time\n"
            "payload = (b'\\x00owned-image\\xff' * 200000)\n"
            "mode = os.environ['FIXTURE_TRANSFER_MODE']\n"
            "if sys.argv[1:3] == ['image','save']:\n"
            " assert sys.argv[3:] == ['sha256:'+'d'*64]\n"
            " sys.stdout.buffer.write(payload)\n"
            " sys.stdout.buffer.flush()\n"
            " sys.exit(5 if mode == 'source-fails' else 0)\n"
            "assert sys.argv[1:] == ['exec','--interactive','a'*64,'docker','image','load']\n"
            "if mode == 'target-fails': sys.exit(6)\n"
            "if mode == 'timeout': time.sleep(300)\n"
            "assert sys.stdin.buffer.read() == payload\n"
        )
        self.cli.chmod(0o700)
        self.children = []
        self.popen = subprocess.Popen

    def tearDown(self):
        for child in self.children:
            self.assertIsNotNone(child.poll(), "Image transfer child was not reaped")
        self.temporary.cleanup()

    def spawn(self, *args, **kwargs):
        child = self.popen(*args, **kwargs)
        self.children.append(child)
        return child

    def transfer(self, mode):
        with (
            patch.object(candidate, "DOCKER", str(self.cli)),
            patch.dict(candidate.ENV, {"FIXTURE_TRANSFER_MODE": mode}),
            patch.object(candidate.subprocess, "Popen", side_effect=self.spawn),
        ):
            candidate.stream_owned_images("a" * 64, ["sha256:" + "d" * 64])

    def test_streams_binary_bytes_without_an_archive(self):
        self.transfer("success")
        self.assertEqual(len(self.children), 2)
        self.assertEqual(list(Path(self.temporary.name).iterdir()), [self.cli])

    def test_requires_both_processes_to_succeed(self):
        for mode in ("source-fails", "target-fails"):
            with self.assertRaises(RuntimeError):
                self.transfer(mode)

    def test_timeout_and_failed_consumer_creation_reap_the_producer(self):
        original_spawn = self.spawn

        def timeout_spawn(*args, **kwargs):
            child = original_spawn(*args, **kwargs)
            if args[0][1] == "exec":
                original_wait = child.wait

                def wait(timeout=None):
                    if timeout == 240:
                        raise subprocess.TimeoutExpired(args[0], timeout)
                    return original_wait(timeout=timeout)

                child.wait = wait
            return child

        with (
            patch.object(self, "spawn", side_effect=timeout_spawn),
            self.assertRaises(subprocess.TimeoutExpired),
        ):
            self.transfer("timeout")

        def reject_spawn(*args, **kwargs):
            if args[0][1] == "exec":
                raise OSError("Owned consumer could not start")
            return original_spawn(*args, **kwargs)

        with (
            patch.object(self, "spawn", side_effect=reject_spawn),
            self.assertRaises(OSError),
        ):
            self.transfer("success")


if __name__ == "__main__":
    unittest.main()
