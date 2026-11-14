import importlib.util
import json
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location(
    "disposable_observer", Path(__file__).with_name("disposable-observation.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DisposableObservationTest(unittest.TestCase):
    def fixture(self):
        record = {
            "epoch": 2,
            "epochId": "disposable-" + "a" * 32,
            "productRevision": "b" * 40,
            "runtimePolicyDigest": "sha256:" + "c" * 64,
            "owner": "123:1",
            "bootId": "11111111-1111-1111-1111-111111111111",
            "nonce": "d" * 64,
            "sourceTree": "e" * 40,
            "issuedAt": 100,
            "expiresAt": 200,
        }
        instance = "fixture-supervisor"
        envelope = json.dumps(
            {
                "raw": json.dumps(record),
                "result": {"signature": "private-test-signature"},
            }
        ).encode()
        policy = json.dumps(
            {
                "components": {
                    "supervisor": {
                        "environment": {"LYRASHIELD_SUPERVISOR_INSTANCE_ID": instance}
                    }
                }
            }
        ).encode()

        def require(value):
            if not value:
                raise RuntimeError("Unavailable")

        observer = SimpleNamespace(
            ROOT=Path("/etc/lyrashield"),
            read_private=Mock(side_effect=[envelope, policy]),
            checksum=lambda value: "sha256:" + ("c" if value == policy else "f") * 64,
            require=require,
            IDENTIFIER=re.compile(r"^[a-z-]+$"),
        )
        disposable = SimpleNamespace(
            load_disposable_native_context=Mock(
                return_value=(record, {"supervisorInstanceId": instance})
            )
        )
        return record, observer, disposable

    def test_emits_only_authenticated_scope_and_public_identity(self):
        _, observer, disposable = self.fixture()
        peer = (201, 11002, 11002)
        result = module.descriptor(peer, observer, disposable)
        disposable.load_disposable_native_context.assert_called_once_with(
            peer, observer
        )
        self.assertEqual(result["purpose"], "disposable-installed")
        self.assertEqual(result["authorityDigest"], "sha256:" + "f" * 64)
        self.assertNotIn("signature", json.dumps(result))
        self.assertEqual(
            set(result),
            {
                "purpose",
                "epochId",
                "epoch",
                "sourceRevision",
                "runtimePolicyDigest",
                "authorityDigest",
                "supervisorInstanceId",
                "owner",
                "bootId",
                "nonce",
                "sourceTree",
                "issuedAt",
                "expiresAt",
            },
        )

    def test_rejects_authenticated_record_or_policy_substitution(self):
        for changed in ("record", "policy", "instance"):
            record, observer, disposable = self.fixture()
            if changed == "record":
                record["productRevision"] = "9" * 40
            elif changed == "policy":
                record["runtimePolicyDigest"] = "sha256:" + "9" * 64
            else:
                disposable.load_disposable_native_context.return_value[1][
                    "supervisorInstanceId"
                ] = "other-instance"
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                module.descriptor((201, 11002, 11002), observer, disposable)


if __name__ == "__main__":
    unittest.main()
