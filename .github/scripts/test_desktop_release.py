import json
import pathlib
import tempfile
import unittest

import desktop_release


class DesktopReleaseTests(unittest.TestCase):
    def write_assets(self, root):
        fixtures = {
            "lyrashield-desktop-macos-aarch64/LyraShield_0.1.1_aarch64.dmg": b"dmg-arm",
            "lyrashield-desktop-macos-aarch64/LyraShield_0.1.1_aarch64.app.tar.gz": b"arm",
            "lyrashield-desktop-macos-aarch64/LyraShield_0.1.1_aarch64.app.tar.gz.sig": b"arm-signature",
            "lyrashield-desktop-macos-x86_64/LyraShield_0.1.1_x86_64.dmg": b"dmg-intel",
            "lyrashield-desktop-macos-x86_64/LyraShield_0.1.1_x86_64.app.tar.gz": b"intel",
            "lyrashield-desktop-macos-x86_64/LyraShield_0.1.1_x86_64.app.tar.gz.sig": b"intel-signature",
            "lyrashield-desktop-windows-x86_64/LyraShield_0.1.1_x64-setup.exe": b"windows",
            "lyrashield-desktop-windows-x86_64/LyraShield_0.1.1_x64-setup.exe.sig": b"windows-signature",
        }
        for relative, data in fixtures.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def test_tag_must_match_desktop_version(self):
        desktop_release.validate_tag_version("v0.1.1", "0.1.1")
        desktop_release.validate_tag_version("v0.1.1-rc.1", "0.1.1-rc.1")
        with self.assertRaisesRegex(ValueError, "does not match"):
            desktop_release.validate_tag_version("v0.1.1", "0.1.0")

    def test_manifest_contains_exact_platforms_and_nonempty_signatures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.write_assets(root)

            manifest = desktop_release.build_manifest(
                root,
                "v0.1.1",
                "ecryptoguru/lyrashield-ai",
                "2026-08-23T12:00:00Z",
            )

            self.assertEqual(manifest["version"], "0.1.1")
            self.assertEqual(
                set(manifest["platforms"]),
                {"darwin-aarch64", "darwin-x86_64", "windows-x86_64"},
            )
            self.assertEqual(
                manifest["platforms"]["windows-x86_64"]["signature"],
                "windows-signature",
            )
            self.assertTrue(
                manifest["platforms"]["darwin-aarch64"]["url"].startswith(
                    "https://github.com/ecryptoguru/lyrashield-ai/releases/download/v0.1.1/"
                )
            )
            json.dumps(manifest)

    def test_manifest_rejects_empty_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact_dir = root / "lyrashield-desktop-macos-aarch64"
            artifact_dir.mkdir(parents=True)
            (artifact_dir / "one.app.tar.gz").write_bytes(b"one")
            (artifact_dir / "one.app.tar.gz.sig").write_text("")
            with self.assertRaisesRegex(ValueError, "empty"):
                desktop_release.find_signed_pair(root, artifact_dir.name, ".app.tar.gz")

    def test_manifest_rejects_duplicate_signed_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact_dir = root / "lyrashield-desktop-macos-aarch64"
            artifact_dir.mkdir(parents=True)
            for name in ("one", "two"):
                (artifact_dir / f"{name}.app.tar.gz").write_bytes(name.encode())
                (artifact_dir / f"{name}.app.tar.gz.sig").write_text(f"{name}-signature")
            with self.assertRaisesRegex(ValueError, "exactly one"):
                desktop_release.find_signed_pair(root, artifact_dir.name, ".app.tar.gz")

    def test_manifest_rejects_wrong_asset_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.write_assets(root)
            artifact = root / "lyrashield-desktop-windows-x86_64" / (
                "LyraShield_0.1.1_x64-setup.exe"
            )
            signature = pathlib.Path(str(artifact) + ".sig")
            artifact.rename(artifact.with_name("LyraShield_0.1.0_x64-setup.exe"))
            signature.rename(signature.with_name("LyraShield_0.1.0_x64-setup.exe.sig"))
            with self.assertRaisesRegex(ValueError, "version"):
                desktop_release.build_manifest(
                    root,
                    "v0.1.1",
                    "ecryptoguru/lyrashield-ai",
                    "2026-08-23T12:00:00Z",
                )


if __name__ == "__main__":
    unittest.main()
