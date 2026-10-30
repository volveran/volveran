# Alerting is declared in the profiles file, and notifications carry no Message content

Volverán can tell people about its dead-letter queues through Alert Destinations (Slack, Microsoft Teams, a generic webhook) and Alert Rules. Both are declared in the profiles file and nowhere else: the web app and the API show them and send test notifications, but cannot create or change one. This follows ADR 0011's reasoning: the file is where a team already reviews and versions what Volverán does, and in a Kubernetes deployment it arrives through the chart and GitOps. A change to who gets told about an incident gets the same review as any other change, and its history is the history of the file.

Two rules hold for every notification:

- **A destination's URL and signing secret come from environment variables.** A webhook URL is a credential: whoever has it can post to the channel. The file names the variable (`urlEnv`, `signingSecretEnv`), the value lives in a Kubernetes Secret, and startup refuses a variable that is not set, so a broken set-up is caught at deploy time rather than during an incident. A URL is never sent to the browser, logged or recorded, and a failed delivery records a status or an error code rather than the error's text, which can name the URL.
- **A notification never contains Message content.** It says which profile, vhost, queue and condition, the current value and threshold, since when, and links to Volverán. It never holds a Message's body, headers or `message_id`. Chat tools keep what they receive, outside the Roles and retention that protect Discarded bodies in the audit store; the link takes a person with a Role to the evidence. Payloads are built from the named fields of a notification only, so nothing else a caller holds can reach them.

## Considered Options

- **Destinations and rules created in the web app, stored in the audit store**: rejected, as in ADR 0011; it needs its own review flow, splits the configuration across two places, and would put credentials in the audit store.
- **URLs written in the file**: rejected; the profiles file is a ConfigMap, reviewed and committed in plain text.
- **An excerpt of the Message in the notification, opt-in per rule**: rejected; one setting would decide whether payload data leaves for a chat tool, and alerting on content is out of scope.

## Consequences

- Changing a destination needs a change to the profiles file or its Secret, and a restart.
- An unset variable stops startup, even for a destination no rule uses yet.
- A notification alone cannot say which Message failed: the Operator follows the link.
- Redirects are not followed: a webhook that moves counts as failed with its 3xx status, rather than handing notifications to an address nobody reviewed.
- A notification also holds `replayRule` and `reason`, which say why the condition holds: a pause's reason, set-up warning codes or a sampling error code. A pause's `reason` can be an Operator's free text, so it leaves for the chat tool as written, cut at 500 characters. Operators should not paste Message content there.
- A test notification has the same shape as an Alert's, with `test: true` in the generic webhook's body, so an Alert Destination can be checked end to end and still tell it apart.
