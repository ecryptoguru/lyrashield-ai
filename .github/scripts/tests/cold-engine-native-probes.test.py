"""Receipt validation regressions. These tests never qualify native runtime behavior."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("native", Path(__file__).parents[1] / "run-cold-engine-native-probes.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def receipt_cases():
    cases = [{"name": name, "exitCode": 0, "physicalRequests": 1, "outputCap": 128,
              "retainedPendingCharge": True} for name in native.CASES[:6]]
    cases.append({"name": native.CASES[6], "exitCode": 0, "physicalRequests": 3,
                  "deniedRequests": 1, "configuredCapUsd": 0.002, "heldReservationsUsd": 0.0017})
    cases.extend({"name": name, "exitCode": 0, "physicalRequests": 1,
                  "retryExitCode": 1, "retainedPendingCharge": True} for name in native.CASES[7:])
    return cases


class ReceiptValidation(unittest.TestCase):
    def test_complete_required_observations(self):
        native.validate_cases(receipt_cases())

    def test_missing_duplicate_failed_or_reordered_cases(self):
        cases = receipt_cases()
        for invalid in (cases[:-1], cases + [cases[0]], list(reversed(cases))):
            with self.subTest(invalid=invalid), self.assertRaises(RuntimeError):
                native.validate_cases(invalid)
        cases[0]["exitCode"] = True
        with self.assertRaises(RuntimeError):
            native.validate_cases(cases)

    def test_missing_cap_retry_pending_and_overbudget_cannot_pass(self):
        changes = ((0, "outputCap", 129), (0, "physicalRequests", 2),
                   (0, "retainedPendingCharge", False), (6, "heldReservationsUsd", 0.003),
                   (6, "heldReservationsUsd", float("nan")), (6, "deniedRequests", 0),
                   (7, "retryExitCode", 0), (8, "retainedPendingCharge", False))
        for index, key, value in changes:
            invalid = copy.deepcopy(receipt_cases())
            invalid[index][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                native.validate_cases(invalid)


    def test_sandbox_negatives_require_actual_positive_canaries_and_all_checks(self):
        cases = [{"name": native.SANDBOX_CASES[0], "exitCode": 0, "sandboxCount": 2,
                  **{key: True for key in ("nonRoot", "configEnv", "environment", "procEnvironment",
                                           "privateFileAbsent", "hostMountsAbsent")}},
                 {"name": native.SANDBOX_CASES[1], "exitCode": 0, "directions": 2,
                  **{key: True for key in ("siblingPositiveLoopbackCanary", "outsideProviderPositiveCanary",
                                           "internalBridge", "iccDisabled")}}]
        native.validate_sandbox_cases(cases)
        with self.assertRaises(RuntimeError):
            native.validate_sandbox_cases(cases[:1])
        for index, key in ((0, "procEnvironment"), (0, "hostMountsAbsent"),
                           (1, "outsideProviderPositiveCanary"), (1, "iccDisabled")):
            invalid = copy.deepcopy(cases)
            invalid[index][key] = False
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                native.validate_sandbox_cases(invalid)


if __name__ == "__main__":
    unittest.main()
