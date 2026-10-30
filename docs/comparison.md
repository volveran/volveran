# How Volverán compares

A factual snapshot of tools that work with RabbitMQ messages, taken from their public websites, documentation and source code in **October 2026**. These tools change quickly; corrections are welcome.

| | Warren | RabbitGUI | RabbitScout | Volverán |
|---|---|---|---|---|
| Form | Self-hosted container, Helm | Desktop app | Self-hosted web app | Self-hosted container, Helm |
| Licence | Proprietary, free Community tier | Proprietary, one-time licence | MIT | Apache-2.0 |
| How Messages are read | Fetched and requeued | Fetched and requeued (first 1,000) | Management API "get" with requeue | Held unacknowledged in a Checkout; nothing is requeued until you decide |
| Others kept away while you work | No | No | No | Yes |
| Per-Message delete / move | Yes / yes | Yes / yes | No / no | Yes / yes |
| Replay using the `x-death` history | Yes (to the original exchange and routing key) | Not documented | No | Yes (to the queue it was dead-lettered from) |
| Different decisions applied in one step | No (one action type at a time, with a dry run) | No | No | Yes |
| Audit trail | Yes | No | No | Yes |
| Restore discarded Messages | Yes (7 days, size-capped) | No | No | Yes (30 days or 1 GiB by default) |
| Production safeguards | Required reasons, roles, four-eyes (paid) | Colour per connection | Confirmation dialogs | Protected Profiles, required reasons, Roles, four-eyes Approval |
| Single sign-on | OIDC (paid) | No | No (per-user broker login) | OIDC |
| Monitoring and alerts | Yes | Partial (topology, forecasts) | Yes (dashboards) | Yes: depth history per dead-letter queue with estimated arrivals, Alerts to Slack, Microsoft Teams and webhooks, Prometheus metrics, a Dead-letter Map |

**Why a Checkout instead of fetch-and-requeue.** On quorum queues, a requeued Message can count as a delivery attempt. Browsing a dead-letter queue a few times can push Messages past the queue's `delivery-limit` and get them dropped or dead-lettered again. A Checkout holds each Message until you decide its fate, so looking at a Message never changes it.

Sources:
- Warren: <https://warrenops.io/docs/>
- RabbitGUI: <https://rabbitgui.com/doc>
- RabbitScout: <https://github.com/Ralve-org/RabbitScout>
