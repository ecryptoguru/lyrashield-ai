"""Check the fixed root census without trusting host-network HOSTNAME values."""

import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "candidate_host", Path(__file__).with_name("disposable-candidate-host.py")
)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class RootContainerIdentityTest(unittest.TestCase):
    def setUp(self):
        self.identity = "a" * 64
        self.reference = host.PREFIX + "host@sha256:" + "b" * 64
        self.row = {
            "Id": self.identity,
            "Config": {"Image": self.reference},
            "HostConfig": {"ReadonlyRootfs": True},
            "State": {"Running": True, "Pid": os.getpid()},
        }

    def docker(self, *args):
        if args == ("ps", "--all", "--quiet", "--no-trunc"):
            return (self.identity + "\n").encode()
        self.assertEqual(args, ("container", "inspect", self.identity))
        return json.dumps([self.row]).encode()

    def test_observes_self_despite_shared_network_hostname(self):
        with (
            patch.dict(os.environ, {"HOSTNAME": "outer-dind-host"}),
            patch.object(host, "docker", side_effect=self.docker),
        ):
            self.assertEqual(host.owned_root_container(self.reference), self.row)

    def test_rejects_other_containers_before_inspection(self):
        for identities in (b"", (self.identity + "\n" + "c" * 64).encode(), b"host"):
            with (
                patch.object(host, "docker", return_value=identities) as observed,
                self.assertRaises(RuntimeError),
            ):
                host.owned_root_container(self.reference)
            observed.assert_called_once_with("ps", "--all", "--quiet", "--no-trunc")

    def test_rejects_wrong_pid_image_and_writable_or_stopped_root(self):
        for field, value in (
            ("Pid", os.getpid() + 1),
            ("Image", host.PREFIX + "host@sha256:" + "d" * 64),
            ("ReadonlyRootfs", False),
            ("Running", False),
        ):
            row = json.loads(json.dumps(self.row))
            section = (
                "Config"
                if field == "Image"
                else "HostConfig"
                if field == "ReadonlyRootfs"
                else "State"
            )
            self.row[section][field] = value
            with (
                patch.object(host, "docker", side_effect=self.docker),
                self.assertRaises(RuntimeError),
            ):
                host.owned_root_container(self.reference)
            self.row = row


if __name__ == "__main__":
    unittest.main()
