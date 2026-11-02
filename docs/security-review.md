# Security review for 1.0: the report

**Who did it.** The project reviewed itself: its maintainer, working with AI coding agents (Claude), with the tools at hand. **No paid outside firm reviewed Volverán, nobody independent has checked this report, and it is not a certification or a penetration test.** Ratings are the project's own judgement. Read it as what an honest first look found, by people who also wrote the code.

The full results, what was seen for each, are in the [threat model](threat-model.md). This page says what the review comes to. To report something it missed, see [`SECURITY.md`](../SECURITY.md).

## The result

**No known high or critical finding is open** in `1.0.0-rc.1`, as of 2026-11-02. Two were rated high, and both are fixed:

| Finding | Rating | State |
|---|---|---|
| No Host or Origin validation in Solo Mode, so a page could act through DNS rebinding | High | Fixed by #123 |
| N1: the release gate did not count high and critical image findings without a fix, 66 of them | High | Fixed by #141: the image moved to Alpine, and the gate counts them |
| No Origin check, so cross-site requests could act, `SameSite=Lax` aside | Medium | Fixed by #123 |
| No security headers | Medium | Fixed by #124 |
| OIDC `code` and `state` in the logs | Medium | Fixed by #125 |
| Unhandled error text returned to clients | Medium | Fixed by #125 |
| N2: the private reporting route did not work | Medium | Closed: enabled by the maintainer |
| N5: an open redirect after sign-in, through a tab in `returnTo` | Medium | Fixed by #123 |
| N6: unauthenticated `/auth/login` writes without limit | Medium | Bounded by #125 at 10,000 sign-ins in progress. There is no rate limit: limit it at your proxy |
| N3: write access to the store yields the forwarding secret, which also crosses the pod network in clear | Medium | **Open, accepted by the maintainer.** Narrowed by the NetworkPolicy, not fixed |
| N4: the forwarding port takes every `/api/` route and any identity from a holder of the secret, so Audit Entries could be forged | Medium | **Open, accepted by the maintainer.** The port is closed by a NetworkPolicy, which needs a CNI that enforces it |
| The session guard tested the raw URL (#126) | Low | Fixed by #125 |
| N7: session ids in clear in the store, broker URLs shown to Operators, groups fixed until the next sign-in | Low | Open |
| No `SECURITY.md`, no scanning | | Rejected as findings: done by #127 and #141 |

## Scanners on this release

- **Image:** 0 high and 0 critical in Grype v0.121.0 and Trivy 0.69.3, when #141 moved to Alpine. `security.yml` repeats Grype on every pull request, and the release's first job repeats it and stops on one. Alpine's vulnerability data may be thinner than Debian's, and only the amd64 image is scanned ([`SECURITY.md`](../SECURITY.md)).
- **`npm audit --audit-level=high`:** passes. It reports 3 moderate, on `glob` and `minimatch` through `@fastify/static`.
- **Dependabot on the default branch:** 7 medium and 4 low, on `glob`, `minimatch` and `fast-uri`. `fast-uri`'s are fixed by updating it, which 1.0 does. The rest are among the proposed risks below.
- **CodeQL:** no open alert.

"Known" means known to these tools on the day they ran. A clean scan is not proof that nothing is vulnerable.

## What was tested

- **The findings of #92, each confirmed or rejected by running it:** real HTTP requests to the built server, against a real RabbitMQ, a mock OIDC provider and PostgreSQL, with the real logs. This was at commit `953fdc6`, before the fixes; each fix has its own tests, on both stores where it matters.
- **Authorization:** a matrix over every registered route and Role, which fails if a new route is missing from it, in the integration suite on every change.
- **Hostile Message content:** markup through body, headers, routing key, message id and queue name, rendered through the real queue table, Message list and Message view with React's server renderer; a source check that the web app has no way to write a string as markup.
- **The forwarding port:** missing, wrong and forged credentials and odd paths, with the results in the [threat model](threat-model.md#reviewed-on-request). With the secret, a forged identity did read and Discard, which is what N4 rates. The NetworkPolicy, on kind with kindnet, from pods with and without the labels.
- **A flood of `/auth/login`,** on the real image at the chart's limits and on PostgreSQL.
- **OWASP ASVS 4.0.3 Level 2, area by area,** as a checklist, some by test and some by reading: [the table](threat-model.md#owasp-asvs-level-2).
- **In a real browser, on this release candidate:** headless Firefox 159 through `scripts/screenshots/browser-check.mjs`. Approvals, Compare, Canary and Restore in the built web app, with sign-in through the mock provider as two Operators. A form POST and a bodyless `fetch` from a foreign site on another port, with the session cookie sent, refused as `foreign_origin`, with no Checkout started. In Solo Mode, a name that resolves to loopback refused as `foreign_host`, and accepted once `VOLVERAN_PUBLIC_URL` names it. There was no CSP violation, and an inline script added by hand as a control was refused and reported. Run once by hand, not by CI.

That browser run found a real bug the suites could not: `Referrer-Policy: no-referrer` makes a browser send `Origin: null` on `navigator.sendBeacon`, so the Origin check refused the web app's own end of a Checkout when leaving the page, and its Messages stayed held until the heartbeat limit. It is fixed in this release. The same run would not find a similar mismatch on a browser it did not use.

## What was not tested

- **Any browser but Firefox.** Chromium and Safari were not tried.
- **A real DNS-rebinding attack.** The browser sent the `Host` such a page would, through a name that resolves to loopback; no address changed under a live page.
- **`SameSite=Lax` across real sibling subdomains.** Another port on the same address stood in for one, which a browser also counts as the same site.
- **Hostile content in the other views.** The ones listed above were rendered with hostile strings. Approvals, Compare, Canary and Restore were run with ordinary Messages, so for hostile strings they rest on the source check.
- **Fuzzing, and load beyond the flood above.**
- **TLS on the forwarding port,** which is plain HTTP by design (N3), and **TLS to PostgreSQL with several Replicas**, never run, though it is the chart's default.
- **A real provider's refresh token rotation:** a strict mock was used. CNIs other than kindnet. A real lost host. Long running.
- **The arm64 image,** which is not scanned.
- **Every commit.** The findings were tested once. The forwarding boundary was read again after #109, #111 and #114 rather than attacked again.

## The risks accepted

Written out, with mitigations, in the [threat model](threat-model.md#accepted-risks): a profile without `roles` keeps everyone `admin`; the metrics port has no sign-in; Discarded bodies and Audit Entries are not encrypted by Volverán; Solo Mode's protection is the loopback address; whoever writes the profiles file or reads the environment has every credential; no login throttling; silent re-sign-in after an idle timeout; and what remains of N3 and N4.

**Three more are proposed and not decided:** the moderate `npm audit` findings on `glob` and `minimatch`, those in `tools/lint`, and test images pinned by tag. They wait for the maintainer.
