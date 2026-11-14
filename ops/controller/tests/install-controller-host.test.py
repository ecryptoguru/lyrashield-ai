"""Exercise the root installer and socket on an isolated Linux filesystem."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


@unittest.skipUnless(
    os.getenv("LYRASHIELD_HOST_INSTALL_TEST") == "1",
    "opt-in disposable Linux installer test",
)
class ControllerHostInstallerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(
            prefix="lyrashield-controller-installer-"
        )
        cls.source = Path(cls.temporary.name)
        files = (
            "ops/controller/install-controller-host.sh",
            "ops/controller/authority-observer.py",
            ".github/scripts/paired-runtime-host-observation.py",
            "ops/controller/lyrashield-authority-observer.socket",
            "ops/controller/lyrashield-authority-observer.service",
            "ops/controller/lyrashield-broker-authority-observer.socket",
            "ops/controller/lyrashield-broker-authority-observer.service",
            "ops/controller/native-executor.py",
            "ops/controller/native-executor-tool.py",
            "ops/controller/native-executor-pty.py",
            "ops/controller/native-engine-result.py",
            "ops/controller/disposable-native-authority.py",
            "ops/controller/disposable-observation.py",
            "ops/controller/worker-observation.py",
            "ops/controller/lyrashield-worker-authority-observer.socket",
            "ops/controller/lyrashield-worker-authority-observer.service",
            "ops/controller/preparation-issuer.py",
            "ops/controller/preparation-acquisition-host.py",
            "ops/controller/source-tree.py",
            "ops/controller/lyrashield-preparation-issuer.socket",
            "ops/controller/lyrashield-preparation-issuer.service",
            "ops/controller/lyrashield-native-executor.socket",
            "ops/controller/lyrashield-native-executor.service",
            "ops/controller/tests/installer-linux.sh",
        )
        for relative in files:
            destination = cls.source / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, destination)
        subprocess.run(["git", "init", "-q", str(cls.source)], check=True)
        subprocess.run(["git", "-C", str(cls.source), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(cls.source),
                "-c",
                "user.name=Installer fixture",
                "-c",
                "user.email=fixture@localhost",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        cls.revision = subprocess.check_output(
            ["git", "-C", str(cls.source), "rev-parse", "HEAD"], text=True
        ).strip()
        subprocess.run(
            [
                "git",
                "-C",
                str(cls.source),
                "update-ref",
                "refs/remotes/origin/main",
                cls.revision,
            ],
            check=True,
        )
        # A mutable overlay must not replace the committed installed implementation.
        (cls.source / "ops/controller/authority-observer.py").write_text(
            "raise RuntimeError('untrusted overlay')\n"
        )
        subprocess.run(
            [
                "docker",
                "build",
                "-q",
                "-t",
                "lyrashield-controller-installer-test",
                str(ROOT / "ops/controller/tests"),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_installs_exact_protected_code_and_preserves_unavailable_authority(self):
        self.run_scenario("success")

    def test_rejects_unprotected_or_unqualified_installation_inputs(self):
        for scenario in (
            "writable",
            "symlink",
            "missing",
            "unmerged",
            "active",
            "active-socket",
            "writable-ledger",
            "symlink-ledger",
        ):
            with self.subTest(scenario=scenario):
                self.run_scenario(scenario)

    def run_scenario(self, scenario):
        source, revision = self.source, self.revision
        if scenario == "unmerged":
            source = Path(self.temporary.name) / "unmerged-source"
            shutil.copytree(
                self.source, source, ignore=shutil.ignore_patterns("unmerged-source")
            )
            (source / "unmerged.txt").write_text("unmerged source\n")
            subprocess.run(["git", "-C", str(source), "add", "."], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(source),
                    "-c",
                    "user.name=Installer fixture",
                    "-c",
                    "user.email=fixture@localhost",
                    "commit",
                    "-qm",
                    "unmerged",
                ],
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
            ).strip()
        result = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "-v",
                f"{source}:/work:ro",
                "lyrashield-controller-installer-test",
                "bash",
                "/work/ops/controller/tests/installer-linux.sh",
                revision,
                scenario,
            ],
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
