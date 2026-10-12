export function terminalCostHealthQuery(workerResourceId) {
  if (
    !/^\/subscriptions\/[a-z0-9-]+\/resourceGroups\/[a-z0-9_.-]+\/providers\/Microsoft\.Compute\/virtualMachines\/[a-z0-9_.-]+$/i.test(
      workerResourceId
    )
  ) {
    throw new Error("an exact worker VM resource ID is required")
  }
  return `let Samples = Syslog
| where TimeGenerated > ago(10m)
| where _ResourceId =~ '${workerResourceId}'
| where SyslogMessage contains_cs 'operational_health_sample'
| extend Sample = parse_json(substring(SyslogMessage, indexof(SyslogMessage, '{')))
| where tostring(Sample.message) == 'operational_health_sample' and tostring(Sample.code) == 'terminal_cost_unreconciled'
| extend ObservedAt = todatetime(Sample.observedAt), State = tostring(Sample.state)
| where ObservedAt > ago(10m) and ObservedAt <= now()
| extend Value = iff(State == 'healthy', 0, 1)
| summarize Value = max(Value) by ObservedAt
| top 1 by ObservedAt desc;
print Value = coalesce(toscalar(Samples | project Value), 1)
| where Value > 0`
}
