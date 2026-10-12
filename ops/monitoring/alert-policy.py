#!/usr/bin/env python3
"""Prepare, apply, and verify an explicit urgent-email Azure Monitor policy.

Default execution only writes a reviewable plan. No provider secrets, billing
records, or application deployment are accessed. All detectors remain enabled.
"""
import argparse
import copy
import json
import re
import subprocess
from pathlib import Path


METRICS = {
    "worker-vm-unavailable": ("worker", "VmAvailabilityMetric", "Maximum", "LessThan", 1, "PT5M", 1, True),
    "worker-cpu-high": ("worker", "Percentage CPU", "Average", "GreaterThan", 85, "PT15M", 2, False),
    "app-no-active-replica": ("app", "Replicas", "Maximum", "LessThan", 1, "PT5M", 1, True),
    "app-replica-restart": ("app", "RestartCount", "Maximum", "GreaterThan", 0, "PT5M", 2, False),
    "scanner-no-active-replica": ("scanner", "Replicas", "Maximum", "LessThan", 1, "PT5M", 1, True),
    "scanner-replica-restart": ("scanner", "RestartCount", "Maximum", "GreaterThan", 0, "PT5M", 2, False),
    "app-http-5xx": ("app", "Requests", "Total", "GreaterThan", 5, "PT5M", 1, True),
    "app-any-5xx": ("app", "Requests", "Total", "GreaterThan", 0, "PT1M", 2, False),
}
LOGS = {
    "scan-readiness-unavailable": (1, True),
    "scan-queue-depth-high": (2, False),
    "scan-queue-oldest-wait-high": (1, True),
    "reconciliation-drift": (1, True),
    "reconciliation-backlog": (1, True),
    "reconciliation-duplicates": (2, False),
    "webhook-catalog-rejection": (1, True),
    "webhook-dead-letter": (1, True),
    "evidence-persistence-failure": (1, True),
    "terminal-cost-unreconciled": (1, True),
}


def az(*args):
    result = subprocess.run(["az", *args, "--only-show-errors", "-o", "json"],
                            check=True, capture_output=True, text=True)
    return json.loads(result.stdout) if result.stdout.strip() else None


def resource_url(subscription, group, kind, name=""):
    version = "2023-12-01" if kind == "scheduledQueryRules" else "2023-01-01"
    if kind == "metricAlerts":
        version = "2018-03-01"
    suffix = "/" + name if name else ""
    return (f"https://management.azure.com/subscriptions/{subscription}/resourceGroups/"
            f"{group}/providers/Microsoft.Insights/{kind}{suffix}?api-version={version}")


def body(resource):
    result = {key: copy.deepcopy(resource[key]) for key in
              ("location", "tags", "kind", "identity", "properties") if key in resource}
    for key in ("createdWithApiVersion", "isLegacyLogAnalyticsRule", "lastUpdatedTime",
                "isWorkspaceAlertsStorageConfigured"):
        result.get("properties", {}).pop(key, None)
    return result


def structured_syslog(lookback):
    return (f"Syslog | where TimeGenerated > ago({lookback}) "
            "| extend j=parse_json(substring(SyslogMessage,indexof(SyslogMessage,'{')))")


def log_query(name, app_name):
    code = name.replace("-", "_")
    if name == "scan-readiness-unavailable":
        return (f"ContainerAppConsoleLogs_CL | where TimeGenerated > ago(10m) "
                f"| where ContainerAppName_s =~ '{app_name}' "
                "| where Log_s has '\"message\":\"Scan service readiness check failed\"' "
                "| summarize FirstSeen=min(TimeGenerated), LastSeen=max(TimeGenerated) "
                "| where LastSeen - FirstSeen > 5m"), "PT10M"
    if name == "webhook-catalog-rejection":
        return (f"ContainerAppConsoleLogs_CL | where TimeGenerated > ago(1h) "
                f"| where ContainerAppName_s =~ '{app_name}' "
                f"| where Log_s has '\"code\":\"{code}\"'"), "PT1H"
    if name in ("reconciliation-backlog", "reconciliation-duplicates"):
        # A successful daily report with zero counts explicitly clears this
        # state. Sparse positive events alone cannot prove recovery.
        query = (structured_syslog("2d") +
                 " | where tostring(j.message) == 'Billing reconciliation complete'"
                 " | summarize arg_max(TimeGenerated, j)")
        if name == "reconciliation-backlog":
            query += (" | where tolong(j.backlog.unprocessedBeforeCoverage) > 0"
                      " or tolong(j.backlog.deadLetterTracks) > 0")
        else:
            query += " | where tolong(j.duplicates.settlementDeliveries) > 0"
        return query + " | project TimeGenerated", "P2D"
    if name == "reconciliation-drift":
        # Separate the hourly queue-repair signal from the daily provider
        # report. An incomplete daily report is an ongoing billing incident.
        billing = (structured_syslog("2d") +
                   " | where tostring(j.message) == 'Billing reconciliation complete'"
                   " or (tostring(j.code) == 'reconciliation_drift' and isnotempty(j.alertSamples))"
                   " | summarize arg_max(TimeGenerated, j)"
                   " | where (tostring(j.message) == 'Billing reconciliation complete'"
                   " and (tobool(j.completed) == false or tolong(j.driftAlerts) > 0))"
                   " or (tostring(j.message) == 'operator_alert' and tolong(j.alertCount) > 0)"
                   " | project TimeGenerated")
        queue = (structured_syslog("2h") +
                 " | where tostring(j.code) == 'reconciliation_drift'"
                 " and isnotnull(tolong(j.value)) | project TimeGenerated")
        return f"union ({billing}), ({queue})", "P2D"
    # Idle queue reconciliation emits at least hourly. A ten-minute event
    # window falsely clears persistent problems between healthy worker ticks.
    return (f"Syslog | where TimeGenerated > ago(2h) "
            f"| where SyslogMessage has '\"code\":\"{code}\"'"), "PT6H"


def desired_resources(args, existing):
    base = f"/subscriptions/{args.subscription}/resourceGroups/{args.resource_group}"
    action_id = base + "/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts"
    action = body(existing.get("actionGroups/lyrashield-operator-alerts", {
        "location": "Global", "properties": {"groupShortName": "LyraOps", "enabled": True}}))
    action["properties"].update(enabled=True, emailReceivers=[{
        "name": "primary-operator", "emailAddress": args.primary_email,
        "useCommonAlertSchema": True}])
    desired = {"actionGroups/lyrashield-operator-alerts": action}
    scopes = {"worker": args.worker_id, "app": args.app_id, "scanner": args.scanner_id}
    for name, (scope, metric, aggregation, operator, threshold, window, severity, email) in METRICS.items():
        key = "metricAlerts/" + name
        resource = body(existing.get(key, {"location": "global", "properties": {}}))
        criterion = {"name": "cond0", "criterionType": "StaticThresholdCriterion",
                     "metricName": metric, "timeAggregation": aggregation,
                     "operator": operator, "threshold": threshold}
        if metric == "Requests":
            criterion["dimensions"] = [{"name": "statusCodeCategory", "operator": "Include", "values": ["5xx"]}]
        resource["properties"].update(
            enabled=True, autoMitigate=True, severity=severity, scopes=[scopes[scope]],
            evaluationFrequency="PT1M", windowSize=window,
            criteria={"odata.type": "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria", "allOf": [criterion]},
            actions=[{"actionGroupId": action_id}] if email else [],
            description="LyraShield urgent email" if email else "LyraShield advisory: Azure Monitor only")
        desired[key] = resource
    app_name = args.app_id.rsplit("/", 1)[1]
    if not re.fullmatch(r"[A-Za-z0-9-]+", app_name):
        raise ValueError("Invalid Container App name")
    for name, (severity, email) in LOGS.items():
        key = "scheduledQueryRules/" + name
        resource = body(existing.get(key, {"location": args.location, "kind": "LogAlert", "properties": {}}))
        query, window = log_query(name, app_name)
        resource["properties"].update(
            enabled=True, autoMitigate=True, severity=severity, scopes=[args.workspace_id],
            evaluationFrequency="PT5M", windowSize=window,
            criteria={"allOf": [{"query": query, "timeAggregation": "Count",
                                  "operator": "GreaterThan", "threshold": 0,
                                  "failingPeriods": {"numberOfEvaluationPeriods": 1, "minFailingPeriodsToAlert": 1}}]},
            actions={"actionGroups": [action_id] if email else [], "customProperties": {}},
            description="LyraShield urgent email" if email else "LyraShield advisory: Azure Monitor only")
        desired[key] = resource
    return desired


def equal_policy(actual, expected, path=()):
    # ARM adds read-only/default properties. Compare every declared field,
    # including empty action lists, rather than only enabled/severity flags.
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        for key, value in expected.items():
            if key in actual:
                observed = actual[key]
            elif path == ("properties",) and key == "actions":
                # Azure omits empty log-rule actions altogether.
                observed = [] if isinstance(value, list) else {}
            elif path == ("properties", "actions") and key in ("actionGroups", "customProperties"):
                observed = [] if key == "actionGroups" else {}
            else:
                return False
            if not equal_policy(observed, value, path + (key,)):
                return False
        return True
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            equal_policy(a, b, path) for a, b in zip(actual, expected))
    if isinstance(expected, str) and expected.startswith("/subscriptions/"):
        return isinstance(actual, str) and actual.lower() == expected.lower()
    return actual == expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("subscription", "resource-group", "primary-email", "worker-id", "app-id",
                  "scanner-id", "workspace-id", "workspace-guid", "location", "plan-dir"):
        parser.add_argument("--" + field, required=True)
    parser.add_argument("--apply", action="store_true", help="Apply after saving and validating the complete plan")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.resource_group) or not re.fullmatch(r"[A-Fa-f0-9-]+", args.subscription):
        parser.error("Invalid resource group or subscription")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", args.primary_email):
        parser.error("A primary operator email is required")
    prefix = f"/subscriptions/{args.subscription}/resourceGroups/{args.resource_group}/providers/".lower()
    for scope in (args.worker_id, args.app_id, args.scanner_id, args.workspace_id):
        if not scope.lower().startswith(prefix):
            parser.error("Every resource must belong to the declared subscription and resource group")
    existing = {}
    for kind in ("actionGroups", "metricAlerts", "scheduledQueryRules"):
        for resource in az("rest", "--method", "get", "--url", resource_url(args.subscription, args.resource_group, kind))["value"]:
            existing[kind + "/" + resource["name"]] = resource
    desired = desired_resources(args, existing)
    validation = {}
    # A missing table or invalid KQL must fail before even changing delivery.
    for name in LOGS:
        query = desired["scheduledQueryRules/" + name]["properties"]["criteria"]["allOf"][0]["query"]
        result = az("monitor", "log-analytics", "query", "--workspace", args.workspace_guid,
                    "--analytics-query", query + " | count", "--subscription", args.subscription)
        count = int(result[0]["Count"])
        validation[name] = count
    directory = Path(args.plan_dir)
    directory.mkdir(parents=True, exist_ok=True)
    # Never overwrite a rollback snapshot on an apply/rerun.
    before = directory / "before.json"
    if not before.exists():
        before.write_text(json.dumps({key: existing.get(key) for key in desired}, indent=2) + "\n")
    (directory / "desired.json").write_text(json.dumps(desired, indent=2) + "\n")
    (directory / "query-validation.json").write_text(json.dumps(validation, indent=2) + "\n")
    changed = {key: value for key, value in desired.items() if not equal_policy(existing.get(key, {}), value)}
    print(json.dumps({"mode": "apply" if args.apply else "plan", "changes": list(changed),
                      "urgentDestination": args.primary_email, "allDetectorsEnabled": True}, indent=2))
    if not args.apply:
        return
    for index, (key, value) in enumerate(changed.items()):
        kind, name = key.split("/", 1)
        file = directory / f"request-{index}.json"
        file.write_text(json.dumps(value, indent=2) + "\n")
        az("rest", "--method", "put", "--url", resource_url(args.subscription, args.resource_group, kind, name), "--body", "@" + str(file))
    after = {}
    for key, value in desired.items():
        kind, name = key.split("/", 1)
        actual = az("rest", "--method", "get", "--url", resource_url(args.subscription, args.resource_group, kind, name))
        after[key] = actual
        receiver_ok = kind != "actionGroups" or all(
            receiver.get("status") == "Enabled" for receiver in actual["properties"]["emailReceivers"])
        if not equal_policy(actual, value) or not receiver_ok:
            (directory / "after.json").write_text(json.dumps(after, indent=2) + "\n")
            raise RuntimeError(f"Azure readback does not match policy: {key}")
    (directory / "after.json").write_text(json.dumps(after, indent=2) + "\n")
    print("Verified all 18 enabled detectors and the single urgent-email destination.")


if __name__ == "__main__":
    main()
