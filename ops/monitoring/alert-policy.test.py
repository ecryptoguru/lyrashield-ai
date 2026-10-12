#!/usr/bin/env python3
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("alert_policy", Path(__file__).with_name("alert-policy.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def arguments(directory="unused"):
    base = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/"
    return SimpleNamespace(subscription="00000000-0000-0000-0000-000000000001", resource_group="rg",
                           primary_email="operator@example.test", worker_id=base + "Microsoft.Compute/virtualMachines/worker",
                           app_id=base + "Microsoft.App/containerApps/app", scanner_id=base + "Microsoft.App/containerApps/scanner",
                           workspace_id=base + "Microsoft.OperationalInsights/workspaces/logs",
                           workspace_guid="00000000-0000-0000-0000-000000000002", location="centralindia", plan_dir=directory)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.args = arguments()
        self.desired = policy.desired_resources(self.args, {})

    def test_all_detectors_enabled_but_only_urgent_rules_email(self):
        self.assertEqual(len(self.desired), 19)
        for key, resource in self.desired.items():
            properties = resource["properties"]
            self.assertTrue(properties["enabled"])
            if key.startswith("actionGroups/"):
                self.assertEqual(len(properties["emailReceivers"]), 1)
                continue
            self.assertTrue(properties["autoMitigate"])
            actions = properties["actions"]
            if key.startswith("scheduledQueryRules/"):
                actions = actions["actionGroups"]
            self.assertEqual(bool(actions), properties["severity"] == 1, key)
        self.assertNotIn("scheduledQueryRules/scan-worker-lease-expired", self.desired)

    def test_single_5xx_remains_visible_without_duplicate_email(self):
        any_errors = self.desired["metricAlerts/app-any-5xx"]["properties"]
        sustained = self.desired["metricAlerts/app-http-5xx"]["properties"]
        self.assertEqual(any_errors["criteria"]["allOf"][0]["threshold"], 0)
        self.assertEqual(any_errors["actions"], [])
        self.assertEqual(sustained["criteria"]["allOf"][0]["threshold"], 5)
        self.assertTrue(sustained["actions"])

    def test_outage_must_cover_entire_five_minute_window(self):
        for name in ("worker-vm-unavailable", "app-no-active-replica", "scanner-no-active-replica"):
            properties = self.desired["metricAlerts/" + name]["properties"]
            self.assertEqual(properties["criteria"]["allOf"][0]["timeAggregation"], "Maximum")
            self.assertEqual(properties["windowSize"], "PT5M")

    def test_hourly_terminal_signal_cannot_expire_after_ten_minutes(self):
        query, window = policy.log_query("terminal-cost-unreconciled", "app")
        self.assertIn("ago(2h)", query)
        self.assertEqual(window, "PT6H")
        # A report every hour remains present across every evaluation, whereas
        # the old ten-minute predicate falsely cleared it for fifty minutes.
        reports = [0, 60, 120]
        for minute in range(1, 180):
            self.assertTrue(any(0 <= minute - report < 120 for report in reports))
        self.assertFalse(any(0 <= 45 - report < 10 for report in reports))

    def test_daily_billing_queries_use_latest_report_and_positive_health_counts(self):
        for name in ("reconciliation-backlog", "reconciliation-duplicates", "reconciliation-drift"):
            query, window = policy.log_query(name, "app")
            self.assertEqual(window, "P2D")
            self.assertIn("arg_max(TimeGenerated, j)", query)
            self.assertIn("Billing reconciliation complete", query)
        drift, _ = policy.log_query("reconciliation-drift", "app")
        self.assertIn("tobool(j.completed) == false", drift)
        self.assertIn("isnotnull(tolong(j.value))", drift)

    def test_readback_checks_empty_action_lists_and_every_criterion(self):
        expected = self.desired["metricAlerts/app-any-5xx"]
        bad = json.loads(json.dumps(expected))
        bad["properties"]["actions"] = [{"actionGroupId": "/unexpected"}]
        self.assertFalse(policy.equal_policy(bad, expected))
        bad = json.loads(json.dumps(expected))
        bad["properties"]["criteria"]["allOf"][0]["threshold"] = 999
        self.assertFalse(policy.equal_policy(bad, expected))

    def test_preserves_other_action_group_channels_and_strips_read_only_fields(self):
        group = {"location": "Global", "properties": {"smsReceivers": [{"name": "pager"}], "createdWithApiVersion": "old"}}
        resources = policy.desired_resources(self.args, {"actionGroups/lyrashield-operator-alerts": group})
        self.assertEqual(resources["actionGroups/lyrashield-operator-alerts"]["properties"]["smsReceivers"], [{"name": "pager"}])
        self.assertNotIn("createdWithApiVersion", resources["actionGroups/lyrashield-operator-alerts"]["properties"])

    def run_cli(self, directory, apply=False, fail_query=False, bad_readback=False, already_matches=False):
        args = arguments(directory)
        argv = ["alert-policy.py"]
        for key, value in vars(args).items():
            argv += ["--" + key.replace("_", "-"), value]
        if apply:
            argv += ["--apply"]
        writes = []
        stored = policy.desired_resources(args, {}) if already_matches else {}
        for key in stored:
            if key.startswith("actionGroups/"):
                stored[key]["properties"]["emailReceivers"][0]["status"] = "Enabled"

        def fake_az(*call):
            if call[0] == "monitor":
                if fail_query:
                    raise RuntimeError("invalid query")
                return [{"Count": "0"}]
            url = call[call.index("--url") + 1]
            kind_name = url.split("/providers/Microsoft.Insights/")[1].split("?")[0]
            method = call[call.index("--method") + 1]
            if "/" not in kind_name:
                return {"value": [dict(value, name=key.split("/")[1]) for key, value in stored.items()
                                  if key.startswith(kind_name + "/")]}
            if method == "put":
                writes.append(kind_name)
                stored[kind_name] = json.loads(Path(call[call.index("--body") + 1][1:]).read_text())
                if kind_name.startswith("actionGroups/"):
                    stored[kind_name]["properties"]["emailReceivers"][0]["status"] = "Enabled"
                return stored[kind_name]
            actual = stored[kind_name]
            if bad_readback:
                actual["properties"]["enabled"] = False
            return actual

        with patch.object(policy, "az", side_effect=fake_az), patch("sys.argv", argv), contextlib.redirect_stdout(io.StringIO()):
            if fail_query or bad_readback:
                with self.assertRaises(RuntimeError):
                    policy.main()
            else:
                policy.main()
        return writes

    def test_plan_is_read_only_and_apply_verifies_all_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.run_cli(directory), [])
            original = Path(directory, "before.json").read_text()
            self.assertEqual(len(self.run_cli(directory, apply=True)), 19)
            self.assertEqual(Path(directory, "before.json").read_text(), original)
            self.assertEqual(len(json.loads(Path(directory, "after.json").read_text())), 19)

    def test_query_failure_prevents_every_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.run_cli(directory, apply=True, fail_query=True), [])

    def test_mismatched_readback_is_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(len(self.run_cli(directory, apply=True, bad_readback=True)), 19)

    def test_matching_policy_is_an_idempotent_apply_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.run_cli(directory, apply=True, already_matches=True), [])


if __name__ == "__main__":
    unittest.main()
