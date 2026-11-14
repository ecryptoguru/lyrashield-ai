"""Exercise private input and exact immutable fixture preflight boundaries."""

import importlib.util
import json
import os
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
            with patch.dict(os.environ, {"DOCKER_HOST": "tcp://example.invalid:2375"}):
                with self.assertRaises(RuntimeError):
                    candidate.load_input(self.path)


if __name__ == "__main__":
    unittest.main()
