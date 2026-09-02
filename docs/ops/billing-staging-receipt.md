# Billing staging receipt input

Dispatch uses five inputs. Set `verify_provider_receipt` and supply `receipt_json` only after the hosted Sandbox/Test provider delivered its webhook. No production admission is changed by this input.

The JSON keys match the previous receipt input names without the `receipt_` prefix:

```json
{
  "provider": "polar",
  "workspace_id": "disposable-workspace",
  "object_id": "provider-subscription",
  "kind": "subscription",
  "phase": "purchase",
  "plan": "STARTER",
  "interval": "MONTHLY",
  "status": "ACTIVE",
  "resolve_polar_subscription_purchase": true
}
```

Supported strings: provider, event_id, workspace_id, kind, phase, object_id, plan, interval, status, minutes, remaining_minutes, commission_count, commission_status, audit_action, audit_resource_id and audit_count. Supported booleans: resolve_razorpay_subscription_charge, resolve_razorpay_subscription_cancellation, resolve_polar_subscription_purchase and resolve_polar_subscription_cancellation.

Use JSON booleans for resolution flags and strings for amounts/counts. Phase defaults to purchase, resolution flags to false and other strings to empty. Unknown fields and unsafe characters fail before Azure login. Source SHA, image digests and revision are always supplied by the workflow, never by this JSON. Provider and application receipt verification retains its existing required-field checks.
