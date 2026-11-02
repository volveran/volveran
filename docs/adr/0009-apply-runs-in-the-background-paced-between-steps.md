# Apply runs in the background, and is paced between steps

Until v0.3 an Apply ran inside its HTTP request: `POST /api/checkouts/:id/apply` answered with the outcomes once every Message was settled. That is fine for a few hundred Messages settled as fast as the broker confirms them, but an Apply that is paced (a Replay Rate) or waits for a Canary lasts minutes, longer than reverse proxies, scripts and browsers wait for one request. So the Apply request (and the approve request of an approved Apply) checks everything that can refuse it, starts the Apply and answers `202` with the Checkout `applying`. The executor carries the steps out in the background, one at a time as ADR 0001 describes, and the Checkout view shows the Apply's progress (`applyProgress`), then the outcome for each Message (`lastApply`) once the Apply has ended the Checkout.

Anything that changes the pace of an Apply happens between steps, never inside one: the executor asks before each step whether to go on (and, with a Replay Rate, waits until the next publish may start), after the previous step's publish confirm and ack. A step in progress always finishes. ADR 0001's ordering within a step (the destination durable before the ack) is unchanged, and so is its guarantee: a stop, the time limit or a crash between steps leaves the remaining Messages held, and they go back to the queue untouched.

## Considered Options

- **Keep the Apply in the request, with a long timeout**: rejected, Volverán does not control the proxies in front of it, and an Operator closing the tab would cancel nothing anyway while seeing nothing.
- **A job queue or a separate worker**: rejected, an Apply acts on the Messages one Checkout holds on its own connection in this process (ADR 0003, ADR 0006); a job outliving the process could not settle them.
- **Pace inside a step (delay the ack after the publish)**: rejected, it holds a published Message unacked for longer, widening the window in which a crash duplicates it, for no gain.

## Consequences

- **Breaking API change.** The Apply and approve answers no longer carry `outcomes`; clients read them from the Checkout view (`GET /api/checkouts/:id`), polling while its status is `applying`.
- An Apply in progress no longer depends on the browser: the heartbeat window is suspended while it runs (and restarts if the Apply leaves the Checkout active), so closing the tab does not stop it.
- The time limit remains a hard bound: at the limit the executor attempts no further step, the rest is reported `not-attempted` and back in the queue, and the Checkout ends (`time-limit`). An Operator's end and shutdown still wait for the Apply to finish.
- A Lost Checkout mid-Apply is reported as before: the step in progress fails or completes, the rest is `not-attempted`, and the broker has already returned those Messages.
