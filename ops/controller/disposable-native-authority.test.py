import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("disposable_native", Path(__file__).with_name("disposable-native-authority.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class DisposableAuthoritySchemaTests(unittest.TestCase):
    def setUp(self):
        self.fields = ("productRevision", "sandboxDigest", "runtimePolicyDigest")
        self.context = {"schema": native.CONTEXT, "owner": "12:1", "bootId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                        "nonce": "a" * 64, "sourceRevision": "b" * 40, "sourceTree": "c" * 40}
        self.record = {"schema": native.SCHEMA, "purpose": native.PURPOSE,
                       "productRevision": "b" * 40, "sandboxDigest": "sha256:" + "d" * 64,
                       "runtimePolicyDigest": "sha256:" + "e" * 64,
                       "epochId": "disposable-" + "f" * 32, "epoch": 1, "owner": self.context["owner"],
                       "bootId": self.context["bootId"], "nonce": self.context["nonce"],
                       "sourceTree": self.context["sourceTree"], "issuedAt": 1000, "expiresAt": 1100,
                       "dependencies": {role: {"name": "lyrashield-fixture-" + role + "-" + "a" * 16,
                                               "image": "fixture/" + role + "@sha256:" + "b" * 64}
                                        for role in native.DEPENDENCIES}}

    def validate(self, record=None, context=None, now=1001):
        return native.validate_record(record or self.record, context or self.context, self.fields, now, self.context["bootId"])

    def test_scope_and_finite_expiry_are_required(self):
        self.assertEqual(self.validate(), self.record)
        for key, value in (("purpose", "launch-qualified-controller"), ("schema", "production-installed"),
                           ("expiresAt", 999), ("expiresAt", 5000), ("issuedAt", 1002),
                           ("owner", "13:1"), ("bootId", "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"),
                           ("nonce", "d" * 64), ("sourceTree", "e" * 40), ("epoch", 0), ("epoch", True)):
            changed = copy.deepcopy(self.record)
            changed[key] = value
            with self.assertRaises(RuntimeError, msg=key):
                self.validate(changed)

    def test_unbounded_image_or_extra_authority_is_rejected(self):
        changed = copy.deepcopy(self.record)
        changed["dependencies"]["database"]["image"] = "postgres:latest"
        with self.assertRaises(RuntimeError):
            self.validate(changed)
        changed = copy.deepcopy(self.record)
        changed["providerAuthority"] = True
        with self.assertRaises(RuntimeError):
            self.validate(changed)


if __name__ == "__main__":
    unittest.main()
