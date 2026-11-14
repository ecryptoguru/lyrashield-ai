"""Disposable Linux bytes/signature fixtures; these never qualify production."""
import importlib.util
import base64
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


issuer = load("preparation-issuer")
tree = load("source-tree")


@unittest.skipUnless(os.geteuid() == 0 and os.uname().sysname == "Linux", "root fixture runs in disposable Linux")
class PreparationIssuerTest(unittest.TestCase):
    def test_full_tree_digest_includes_ignored_files_and_rejects_mutable_links(self):
        with tempfile.TemporaryDirectory(dir="/run") as directory:
            root = Path(directory) / "source"
            root.mkdir()
            (root / "pkg").mkdir()
            (root / "README.md").write_bytes(b"readme\n")
            (root / "pkg/mod.py").write_bytes(b"x = 1\n")
            issuer.freeze(root)
            first = tree.read_source_tree(root)
            self.assertEqual(first["stagedTreeDigest"], "ab93f8d25dd1885e3e5d09b9bcfc70aa8f312d3b03766d49daa6d09230dd6e84")
            root.chmod(0o750)
            (root / ".ignored").write_bytes(b"actual staged bytes")
            issuer.freeze(root)
            self.assertNotEqual(tree.read_source_tree(root)["stagedTreeDigest"], first["stagedTreeDigest"])
            (root / "README.md").chmod(0o640)
            with self.assertRaises(RuntimeError):
                tree.read_source_tree(root)
            (root / "README.md").chmod(0o440)
            root.chmod(0o750)
            (root / "alias").symlink_to("README.md")
            root.chmod(0o550)
            with self.assertRaises(RuntimeError):
                tree.read_source_tree(root)
            (root / "alias").unlink()
            os.link(root / "README.md", root / "hardlink")
            with self.assertRaises(RuntimeError):
                tree.read_source_tree(root)

    def test_extracts_exact_commit_blobs_and_pinned_comparison_base_without_filters(self):
        with tempfile.TemporaryDirectory(dir="/run") as directory:
            root = Path(directory)
            repository = root / "fixture"
            repository.mkdir()
            def git(*args):
                return subprocess.run(["git", "-C", str(repository), *args], check=True, capture_output=True).stdout.decode().strip()
            git("init", "--quiet")
            git("config", "user.name", "Disposable fixture")
            git("config", "user.email", "fixture@example.invalid")
            (repository / "data.bin").write_bytes(b"base\x00\xff")
            git("add", ".")
            git("commit", "--quiet", "-m", "base")
            base = git("rev-parse", "HEAD")
            (repository / "data.bin").write_bytes(b"head\x00\xff")
            (repository / ".hidden").write_bytes(b"included")
            git("add", ".")
            git("commit", "--quiet", "-m", "head")
            head = git("rev-parse", "HEAD")
            source = root / "staged"
            source.mkdir(mode=0o700)
            actual_execute = issuer.execute
            def local_fixture_execute(args, **kwargs):
                # Only this test replaces authenticated GitHub fetch with its disposable local repository.
                if args[0] == "/usr/bin/git" and "fetch" in args:
                    args = [str(repository) if item.startswith("https://github.com/") else item for item in args]
                    kwargs["env"] = {**kwargs["env"], "GIT_CONFIG_VALUE_4": "always"}
                return actual_execute(args, **kwargs)
            with patch.object(issuer, "execute", side_effect=local_fixture_execute), patch.object(issuer, "module", return_value=tree):
                receipt = issuer.install_repository(source, {"executionPlan": {"targetType": "REPO", "workflow": "REVIEW_CHANGES",
                    "source": {"revision": head, "baseRevision": base, "mergeBaseRevision": base}},
                    "target": {"repoFullName": "owner/repository"}, "token": "fixture-only"})
            self.assertEqual((source / "data.bin").read_bytes(), b"head\x00\xff")
            self.assertEqual((source / ".hidden").read_bytes(), b"included")
            self.assertEqual(tree.read_source_tree(source), receipt)
            self.assertTrue(any(item["path"].startswith(".git/") for item in receipt["entries"]))
            self.assertEqual(os.stat(source).st_uid, 0)
            self.assertFalse(os.stat(source).st_mode & 0o222)
            self.assertIn(base.encode(), subprocess.run(["git", "-c", "safe.directory=" + str(source), "-C", str(source), "rev-parse", base], check=True, capture_output=True).stdout)
            self.assertEqual(subprocess.run(["git", "-c", "safe.directory=" + str(source), "-C", str(source), "merge-base", base, head], check=True, capture_output=True).stdout.decode().strip(), base)
            self.assertIn(b".hidden", subprocess.run(["git", "-c", "safe.directory=" + str(source), "-C", str(source), "diff", "--name-only", base + "..." + head], check=True, capture_output=True).stdout)
            self.assertNotIn(b"fixture-only", (source / ".git/config").read_bytes())

    @unittest.skipUnless(os.environ.get("LYRASHIELD_TEST_PREPARATION_NAMESPACE") == "1", "mount namespace fixture requires isolated privileged Linux")
    def test_private_image_clone_preserves_network_and_overrides_only_helper_dns(self):
        # This local test entrypoint measures the actual kernel/ABI mechanism; it is not a production SDK qualification.
        script = Path("/app/src/preparation-acquire.mjs")
        existed = script.exists()
        prior = script.read_bytes() if existed else None
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text('import fs from "node:fs"; process.stdout.write(JSON.stringify({resolver:fs.readFileSync("/etc/resolv.conf","utf8"),network:fs.readlinkSync("/proc/self/ns/net"),rootUid:fs.statSync("/").uid,status:fs.readFileSync("/proc/self/status","utf8")}));')
        state = Path("/var/lib/lyrashield/preparation")
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        state.chmod(0o700)
        before = Path("/etc/resolv.conf").read_bytes()
        # A separate mount AND network namespace supplies the real immutable image ABI.
        fixture_code = """
import ctypes,json,os,tempfile,shutil,sys
from pathlib import Path
c=ctypes.CDLL(None,use_errno=True)
assert c.unshare(0x00020000|0x40000000)==0
assert c.mount(None,b"/",None,16384|262144,None)==0
root=Path(tempfile.mkdtemp(prefix="preparation-image-",dir="/run"))
mounted=[]
try:
 for name in ("usr","lib","app","proc"):
  target=root/name;target.mkdir()
  assert c.mount(("/"+name).encode(),str(target).encode(),None,4096|16384,None)==0
  mounted.append(target)
 (root/"etc").mkdir();(root/"etc/resolv.conf").write_text("nameserver 127.0.0.11\\n")
 print(json.dumps({"root":str(root),"network":os.readlink("/proc/self/ns/net")}),flush=True)
 sys.stdin.read(1)
finally:
 for target in reversed(mounted): assert c.umount2(str(target).encode(),2)==0
 shutil.rmtree(root)
"""
        child_image = subprocess.Popen(["/usr/bin/python3", "-I", "-c", fixture_code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        fixture = json.loads(child_image.stdout.readline())
        image_root = Path(fixture["root"])
        image = os.open(Path("/proc")/str(child_image.pid)/"root"/str(image_root).lstrip("/"),os.O_PATH|os.O_DIRECTORY)
        namespace = os.open(Path("/proc")/str(child_image.pid)/"ns/mnt",os.O_RDONLY)
        try:
            with tempfile.TemporaryDirectory(prefix="acquisition-", dir=state) as mount_root:
                snapshot = Path(mount_root) / "resolver.snapshot"
                snapshot.write_bytes(b"nameserver 203.0.113.42\n")
                snapshot.chmod(0o400)
                resolver = os.open(snapshot,os.O_RDONLY|os.O_NOFOLLOW)
                target = Path(mount_root) / "image"
                target.mkdir(mode=0o700)
                try:
                    child = subprocess.run(["/usr/bin/python3", "-I", "-c", "import runpy;runpy.run_path('/work/ops/controller/preparation-acquisition-host.py')['launch']()", str(image), str(namespace), str(resolver), str(target)], pass_fds=(image,namespace,resolver), capture_output=True, timeout=45)
                    self.assertEqual(child.returncode, 0, child.stderr.decode())
                    result = json.loads(child.stdout)
                finally:
                    os.close(resolver)
            self.assertEqual(result["resolver"], "nameserver 203.0.113.42\n")
            self.assertEqual(result["network"], os.readlink("/proc/self/ns/net"))
            self.assertNotEqual(result["network"],fixture["network"])
            self.assertEqual(result["rootUid"], 0)
            self.assertIn("CapEff:\t0000000000000000",result["status"])
            self.assertIn("NoNewPrivs:\t1",result["status"])
            self.assertEqual(Path("/etc/resolv.conf").read_bytes(), before)
        finally:
            os.close(image)
            os.close(namespace)
            child_image.communicate(b"x",timeout=10)
            self.assertEqual(child_image.returncode,0)
            if existed:
                script.write_bytes(prior)
            else:
                script.unlink()

    def test_rejects_missing_or_moving_revision_before_git_or_signer(self):
        with tempfile.TemporaryDirectory(dir="/run") as directory, patch.object(issuer, "execute") as execute:
            for revision in ("main", "abc", "f" * 39):
                with self.subTest(revision=revision), self.assertRaises(RuntimeError):
                    issuer.install_repository(Path(directory), {"executionPlan": {"targetType": "REPO", "workflow": "REVIEW_TARGET", "source": {"revision": revision}}, "target": {"repoFullName": "owner/repo"}, "token": "fixture"})
            execute.assert_not_called()

    def test_source_network_runs_after_metadata_and_rejects_changed_current_authority(self):
        before = {"operationId":"operation-one", "workspaceId":"workspace-one"}
        events = []
        def acquire(source):
            self.assertEqual(events,["metadata"])
            self.assertEqual(source,before)
            events.append("network")
            return {"token":"fixture-only", "attachmentBytes":[]}
        def read(args,**kwargs):
            events.append("metadata")
            return issuer.canonical(before).encode()
        with patch.object(issuer,"execute",side_effect=read), patch.object(issuer,"acquire_artifacts",side_effect=acquire):
            self.assertEqual(issuer.read_source("operation-one","a"*64,True)["token"],"fixture-only")
        self.assertEqual(events,["metadata","network","metadata"])
        with patch.object(issuer,"execute",side_effect=[issuer.canonical(before).encode(),issuer.canonical({**before,"workspaceId":"changed"}).encode()]), patch.object(issuer,"acquire_artifacts",return_value={"token":"fixture-only", "attachmentBytes":[]}):
            with self.assertRaises(RuntimeError):
                issuer.read_source("operation-one","a"*64,True)

    def test_root_protocol_has_no_generic_sign_sql_shell_or_path_method(self):
        for method in ("sign", "sql", "shell", "execute", "stage"):
            with self.subTest(method=method), patch.object(issuer, "installation") as installation:
                with self.assertRaises(RuntimeError):
                    issuer.dispatch({"schema": 1, "method": method, "operationId": "operation-one", "path": "/tmp/source"}, (1, 2, 3))
                installation.assert_not_called()

    def test_fixture_signature_and_catalog_bind_exact_attempt_source_and_descriptors(self):
        with tempfile.TemporaryDirectory(dir="/run") as directory:
            root = Path(directory)
            state, inputs, control = root / "state", root / "inputs", root / "control"
            for path in (state, inputs, control):
                path.mkdir(mode=0o700)
            (control / "resources").mkdir(mode=0o700)
            private = control / "preparation-grant-key.pem"
            public = control / "public.pem"
            subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", str(private)], check=True, stderr=subprocess.DEVNULL)
            private.chmod(0o400)
            public.write_bytes(subprocess.run(["openssl", "pkey", "-in", str(private), "-pubout"], check=True, capture_output=True).stdout)
            source = inputs / "source-one"
            source.mkdir(mode=0o700)
            (source / "data.bin").write_bytes(b"real staged bytes\x00\xff")
            issuer.freeze(source)
            digest = tree.read_source_tree(source)["stagedTreeDigest"]
            now = datetime.now(timezone.utc)
            delegation = {"issuerKeyId": "https://fixture.invalid/preparation-only", "issuedAt": (now - timedelta(seconds=1)).isoformat(),
                          "expiresAt": (now + timedelta(minutes=15)).isoformat(), "preparationPolicyChecksum": "a" * 64}
            installed = {"purpose": "production-installed", "preparation": delegation, "epochId": "epoch-one"}
            policy = {"issuerKeyHash": "b" * 64, "engineImage": "fixture/engine@sha256:" + "c" * 64,
                      "sandboxImage": "fixture/sandbox@sha256:" + "d" * 64, "network": "fixture-only",
                      "isolation": {"networkPolicyChecksum": "e" * 64, "seccompPolicyChecksum": "f" * 64, "appArmorProfile": "fixture"}}
            snapshot = {"operationId": "operation-one", "scanId": "scan-one", "workspaceId": "workspace-one", "workerInstanceId": "worker-one",
                        "workerGrantId": "grant-one", "executionPlan": {"targetType": "REPO", "workflow": "REVIEW_TARGET", "source": {"revision": "a" * 40}},
                        **{key: "a" * 64 for key in ("executionPlanHash", "targetSnapshotDigest", "scopeDigest", "policyDigest")}}
            resources = {"source": {"grantId": "source-one", "root": "/workspace/source", "revision": "a" * 40, "stagedTreeDigest": digest, "readOnly": True},
                         "attachments": None, "relay": None,
                         "egress": {"grantId": "egress-one", "policyPath": "/run/lyrashield-egress/policy.json", "policyChecksum": "e" * 64, "authorizedHosts": [], "relayRequired": False, "readOnly": True}}
            saved = {"state": "READY", "snapshot": snapshot, "installed": installed, "resources": resources, "observed": {"fixtureOnly": True}}
            issuer.write_once(state / (issuer.checksum(b"operation-one") + ".json"), saved)
            authority = {key: snapshot[key] for key in ("executionPlan", "executionPlanHash", "targetSnapshotDigest", "scopeDigest", "policyDigest", "workerGrantId")}
            authority["attempt"] = {"operationId": "operation-one", "attemptId": "attempt-one", "scanId": "scan-one", "workspaceId": "workspace-one",
                                    "authorityEpochId": "epoch-one", "workerIdentity": "worker-one", "expiresAt": (now + timedelta(minutes=1)).isoformat()}
            def output(args, input_bytes=None, limit=1024):
                return subprocess.run(args, input=input_bytes, capture_output=True, check=True).stdout
            observer = SimpleNamespace(read_private=lambda path, limit=16384: path.read_bytes(), output=output)
            with (patch.object(issuer, "STATE", state), patch.object(issuer, "INPUTS", inputs), patch.object(issuer, "CONTROL", control),
                  patch.object(issuer, "installation", return_value=(observer, None, installed, None, policy)), patch.object(issuer, "module", return_value=tree)):
                request = {"operationId": "operation-one", "authority": authority}
                envelope = issuer.bind(request, (1, 2, 3))
                self.assertEqual(issuer.bind(request, (1, 2, 3)), envelope)
                signature = root / "signature.bin"
                signature.write_bytes(base64.b64decode(envelope["result"]["signature"]))
                subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(public), "-signature", str(signature)], input=envelope["raw"].encode(), check=True, stdout=subprocess.DEVNULL)
                record = json.loads(envelope["raw"])
                self.assertEqual(record["resources"]["source"]["stagedTreeDigest"], digest)
                self.assertEqual(record["purpose"], "production-preparation")
                self.assertEqual(record["attemptId"], "attempt-one")
                descriptors = [{"schema": "lyrashield-executor-resources/1", "hostPolicyChecksum": "a" * 64, "imageDigest": image.split("@")[1],
                    "uid": 1000, "gid": 1000, "workspaceRoot": "/workspace", "workdir": "/workspace", **resources,
                    "scratchRoot": "/workspace/.attachments-scratch", "isolation": {**policy["isolation"], "dropCapabilities": "ALL", "noNewPrivileges": True, "readOnlyRoot": True, "shmMb": 512},
                    "stagingRecordChecksum": issuer.checksum(envelope["raw"].encode()), "issuerKeyHash": "b" * 64}
                    for image in (policy["engineImage"], policy["sandboxImage"])]
                install = {"operationId": "operation-one", "attemptId": "attempt-one", "descriptors": descriptors}
                self.assertEqual(issuer.install(install, (1, 2, 3)), {"installed": True})
                catalog = json.loads((control / "resources" / (issuer.checksum(envelope["raw"].encode()) + ".json")).read_bytes())
                self.assertEqual(catalog["descriptorChecksums"], sorted(issuer.checksum(item) for item in descriptors))
                self.assertEqual((control / "resources" / (issuer.checksum(envelope["raw"].encode()) + ".json")).stat().st_uid, 0)
                descriptors[0]["source"] = {**resources["source"], "stagedTreeDigest": "0" * 64}
                with self.assertRaises(RuntimeError):
                    issuer.install(install, (1, 2, 3))
                authority["scopeDigest"] = "0" * 64
                with self.assertRaises(RuntimeError):
                    issuer.bind(request, (1, 2, 3))


if __name__ == "__main__":
    unittest.main()
