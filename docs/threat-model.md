# Threat model

What Volverán protects, from whom, where it trusts what, and what was found by testing it. This review was done by the project with the tools at hand, not by an outside firm, and it is not a certification.

Tested on 2026-11-01 at commit `953fdc6` (`integration/v1.0`), before the fixes in #123, #124 and #125, so the results below describe that commit. Unless a line says otherwise, a result comes from real HTTP requests to `node dist/server/main.js` processes against the test broker, mock OIDC provider and PostgreSQL, with their real logs. Nothing was tested in a browser: where a result depends on what a browser does, it says so. Ratings are the project's own judgement of impact and likelihood.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Messages held in a Checkout | The Owner Replica's memory and AMQP connection | Production data, and a Discard or Move changes where it ends up |
| Audit Entries | Audit store | The record of who did what to which Message |
| Discarded bodies | Audit store, 30 days by default, **not encrypted** | Production data; Restore republishes them |
| Broker credentials | Environment, from a Secret | Act on the broker as Volverán's user |
| OIDC client secret, session secret | Environment | Sign-in; the session secret signs cookies |
| Session encryption key, access and refresh tokens | Key in the environment; tokens sealed with AES-256-GCM on PostgreSQL, in memory on SQLite | `operatorToken` profiles reach the broker with these tokens |
| Forwarding secret | Environment | Whoever holds it and can reach the port acts as any Operator |
| Availability of Alerts | Background Leader | Volverán is what says a dead-letter queue is filling up |

## Actors

| Actor | Can | Should not be able to |
|---|---|---|
| Anyone who can publish to a queue | Put any body, header, routing key or queue name in front of an Operator | Run script in that Operator's browser |
| A malicious website in an Operator's browser | Send cross-site requests; rebind DNS to a loopback address | Act as the Operator |
| Unauthenticated client of the web port | Reach `/auth/*`, probes and static files | Reach any `/api/` route, or exhaust the service |
| Signed-in Operator (no Role, `viewer`, `operator`, `admin`) | What their Role on each Broker Profile allows | Exceed it, or use another Operator's Checkout |
| Reader of the logs | Read logs | Gain sign-in or broker access from them |
| Holder of a database dump | Read the store | Use tokens, or forge a session cookie |
| Holder of write access to the store | Change Audit Entries and routing rows | Gain broker access through Volverán |
| Workload on the pod network | Reach pod addresses a NetworkPolicy does not close | Act as an Operator through the forwarding port |
| Author of the profiles file | Everything: it is trusted configuration | |

## Trust boundaries

1. **Browser to web port.** TLS ends at the proxy in front of Volverán. In Team Mode the signed, `HttpOnly`, `SameSite=Lax` session cookie is the credential. In Solo Mode there is no credential, only the loopback address.
2. **Replica to Replica (forwarding).** A separate internal port, plain HTTP, with a shared secret sent as a bearer token and the Operator's identity base64url-encoded beside it. The receiver takes that identity and its groups as stated, so everything rests on the secret and on who can reach the port. The chart does not yet deploy this port or a NetworkPolicy for it (#121).
3. **Replica to audit store.** The store is trusted. In particular, a Replica sends the forwarding secret to whatever address the `replicas` table names (finding N3).
4. **Replica to broker.** Shared credentials, or the Operator's token on `operatorToken` profiles (ADR 0008).
5. **Replica to OIDC provider.** Authorization code flow with PKCE, `state` and `nonce`. Plain http is refused except for a provider on loopback (tested).
6. **Scraper to metrics port.** No sign-in, on its own port (accepted, below).

## Results for the findings in #92

| Finding | Result | Rating | Fix | What was tested and seen |
|---|---|---|---|---|
| No CSRF token or Origin check | **Confirmed** | Medium in Team Mode | #123 | With a session cookie and `Origin: https://evil.example`, `Sec-Fetch-Site: cross-site`: start 201, Decisions 200, Apply 202, queue empty afterwards. `SameSite=Lax` is the only protection, and it does not cover a same-site origin such as a sibling subdomain; the browser's part was not tested. A POST with no body and no content type, which needs no preflight, starts a Checkout (201) and ends one (200). `text/plain`, form and multipart bodies are refused. No CORS header is ever sent |
| No Host or Origin validation in Solo Mode | **Confirmed** | High | #123 | With `Host: evil.example` and a foreign Origin, the whole flow worked: read a held body, Decide, Apply Discard, queue empty, Audit Entry recorded under the Solo Operator. This is what a DNS-rebinding page would send; the rebinding itself was not performed. With only a foreign Origin, a bodyless POST started a Checkout and took the Messages off the queue. Solo Mode does refuse to listen on `0.0.0.0` |
| No security headers | **Confirmed** | Medium | #124 | `/`, a static file, `/api/session`, `/auth/login`, `/healthz`: no `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options` or `Referrer-Policy`. No HSTS with `X-Forwarded-Proto: https` either |
| OIDC `code` and `state` reach logs | **Confirmed** | Medium | #125 | After a real sign-in, the exact `code` and `state` are in the log: `"url":"/auth/callback?code=...&state=..."` in Fastify's `incoming request` line. By then the code has been used, and a stolen one is also bound to PKCE, which limits the harm; a code from a failed or interrupted sign-in may still be live until it expires. **Not found** in logs in the same runs: the session cookie, OIDC client secret, session secret, encryption key, forwarding secret, broker password, PostgreSQL password, a Message body |
| Unhandled error messages returned to clients | **Confirmed** | Medium | #125 | With PostgreSQL stopped, `/api/session`, `/api/audit-entries`, a Checkout start, and unauthenticated `/auth/login` answer 500 `connect ECONNREFUSED 127.0.0.1:<port>`. The refusal in `/%61pi/checkouts/<id>` below shows a raw `TypeError`. **Client errors also become 500** and should keep their status: malformed JSON, empty JSON, a body over the limit, an unsupported media type, and a Forbidden from the static files (`/%2e%2e/...`); `//api/session` also answers 500. PostgreSQL's connection string did not appear in a startup failure |
| No `SECURITY.md` | **Rejected, fixed by #127 on this branch; see N2** | | | The file gives a route, response time and supported versions. It is not on `main` yet, and the route it gives does not work today |
| No dependency or image scanning | **Rejected, fixed by #127 on this branch; see N1** | | | `npm audit --audit-level=high` exits 0 on both lockfiles (moderate findings below). `security.yml` passes on pull requests into `integration/v1.0`. It is not on `main` yet, so the weekly run has never run: GitHub schedules only from the default branch |

## Reviewed on request

**The session guard tests the raw URL (#126). Confirmed, low.** `/%61pi/session` passes the guard and reaches the handler. All 41 `/api/` requests sent this way without a session, covering the routes, answered 401 `not_signed_in` from `operatorOf`, so no route is open. Other spellings (`/a%70i/`, `/api//session`, `/api/session/`, the absolute form of the URL, `;x`, `%00`, `%20`) also answered 401, and those the router does not take as `/api/` served the web app or a 500 and no data.

Two things are worse than the note on #126 says. A Replica that does not own a Checkout answers `/%61pi/checkouts/<id>` with **500** `Cannot destructure property 'id' of 'object null'`, not 401, because `toOwner` runs before the handler's `operatorOf`. It fails before anything is forwarded, so no request crosses, but without a session it tells an existing Checkout id (500) from an unknown one (401), given a random UUID. And an Operator with a valid session gets the same 500, since the guard also skips reading the session. Rating stays low. Testing `req.routeOptions.url` closes all of it.

**The image scan counts only findings with a fix available (#127). See N1.**

**The forwarding port and its secret.** These held:

| Request to the forwarding port | Answer |
|---|---|
| No headers; operator only; wrong secret; secret with no, empty or garbage operator; `bearer` in lower case | 401 `forwarding_refused` |
| Secret and operator, on `/healthz`, `/auth/logout`, `/index.html`, `/%61pi/session` | 401 `forwarding_refused` |
| Secret and operator, `/api/../auth/login`, `/api/..%2fauth/login` | 500 `internal_error` and 404: no sign-in route reached |

| Elsewhere | Answer |
|---|---|
| Secret and forged operator on the **web** port | 401 |
| Valid session plus a forged operator header on the web port | The session's Operator; the header is ignored |
| Through the other Replica: the owner / another Operator / no Role / no session | 200 / 403 `not_checkout_owner` / 403 / 401 |
| A forwarding secret under 32 characters | Startup refused |
| The secret in either Replica's logs | Absent |

And these are what the design leaves open, rated in N3 and N4: with the secret, a forged identity read Audit Entries (a route that is never forwarded), then started a Checkout, and Discarded its Messages, with the Audit Entries naming the forged Operator.

## After the fix: security headers and hostile content (#124)

Unlike the rest of this document, this was tested after the fix. The web port now sends `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy` on every answer, including those Fastify writes without running a hook, and `Strict-Transport-Security` when `VOLVERAN_PUBLIC_URL` is https or `X-Forwarded-Proto` says https. `Cache-Control: no-store` is the default, which the web app's static files replace with their own. The metrics port sends the same, without HSTS. The forwarding port does not, as no browser reaches it. A malformed request that never becomes an HTTP request (Node's `clientError` answer) carries none of them. `img-src` allows `data:` for the wordmark's CSS mask.

- **In the suite, with no browser:** `test/integration/security-headers.test.ts` checks the headers, including through another Replica, and reads the built page, styles and script for what the policy would refuse. `test/integration/hostile-content.test.ts` feeds markup through body, headers, routing key, message id and queue name; it checks the answers can only be read as data, renders the real queue table, Message list and Message view with those answers through React's server renderer, and checks the web source has no way to write a string as markup. Other views are covered by that source check alone.
- **Once by hand, in real headless Firefox, not repeated by CI:** the built app served by `node dist/server/main.js`, with hostile Messages on a real broker. In Solo Mode: queue list, Checkout, Message view, the export button, one Discard through Apply with its progress bar (React's `style` width applied, 0% to 100%), Audit, Replay rules, Alerts, Dead-letter Map and depth history. In Team Mode: sign-in through the mock provider and sign-out. There was no CSP violation event or failed request other than the 401s before sign-in, both fonts loaded, and the hostile strings showed as text with no element or script from them. As a control, an inline script, an inline handler, an inline style and a fetch to another origin, added by hand, were each refused and reported, so the policy was enforced and the watch would have seen a breach. **Not visited in a browser:** Approvals, Compare, Canary, Restore, the hostile queue on the Dead-letter Map (it had no dead-letter link), and whether the export's file reached the disk. Chromium and Safari were not tried, and the Firefox used is 158.

## New findings

No finding other than N1 is rated high or critical.

### N1. The release gate does not count known high and critical image findings. High

`only-fixed: true` in `security.yml` and `release.yml`. Grype v0.121.0 on the image built from this commit:

| | Critical | High | Medium | Low | Negligible |
|---|---|---|---|---|---|
| As CI runs it (`--only-fixed`) | 0 | 0 | 6 | 4 | 0 |
| Every finding (package matches) | 2 | 64 | 78 | 17 | 65 |

The 66 high and critical matches are 20 distinct CVEs, 1 critical (CVE-2026-5450, glibc `scanf` with `%mc`), all in Debian 12 packages marked `wont-fix` or `not-fixed`, none in npm packages. Nothing reports them while CI is green, and the log hides them too, despite the workflow's comment that what is below the cut-off stays visible.

This contradicts two statements: #92's "Known high and critical findings block the release; anything else is fixed or written down as an accepted risk", and `SECURITY.md`'s "A release does not go out with a known high finding in its dependencies or image".

The likely exposure looks small. From their descriptions, most concern tools or calls a Node server does not obviously use (`mount`, `nsenter`, `infocmp`, Perl modules, `gzip`), and the container runs non-root with a read-only filesystem. That is a reading of descriptions, not a per-CVE check: none was shown unreachable, and `libc6`, `libstdc++6` and `zlib1g` are loaded by the process. The rating is high because the release promise does not hold, not because an exploit was shown.

Moving base does not settle it by itself: `node:24-trixie-slim` as published has 0 critical and 21 distinct high findings (6 of the matches are npm packages, `undici` and `brace-expansion`; this image removes npm, which probably carries them, but that was not checked). A distroless base was not tried. The narrowing was reasonable for keeping a pull request's check actionable; what is missing is the decision about what it hides. Options: a smaller base, a reviewed per-CVE list of accepted findings with a report of everything unfixed, and in any case a `SECURITY.md` that says what is really promised. Needs a maintainer's decision.

### N2. The private reporting route does not work. Medium

`SECURITY.md` sends reporters to `/security/advisories/new`, but `GET repos/volveran/volveran/private-vulnerability-reporting` answers `{"enabled":false}` on this public repository. Until it is switched on in the repository's settings, a researcher has no private route, which is #127's first criterion. `SECURITY.md` is also not on `main` yet, so GitHub does not show it.

### N3. Write access to the store yields the forwarding secret. Medium

A Replica sends `Authorization: Bearer <secret>` to whatever address the `replicas` table names. Setting `forwarding_address` to a listener of ours and requesting another Replica's Checkout delivered the real secret and the Operator's identity to that listener, and the Operator received the listener's forged answer as the Checkout. So write access to the store, which should not by itself reach any broker, becomes the ability to act as any `admin` on every Broker Profile, for anyone who can then reach the forwarding port. The secret also crosses the pod network in clear on every forwarded request, so anything that can read that traffic gets the same. Signing each request (an HMAC over method, path, operator and time) rather than sending the secret would stop both.

### N4. The forwarding port accepts every `/api/` route and any identity. Medium

The listener refuses non-`/api/` paths, but does not limit itself to the routes that forward, and accepts any operator and groups. So one leaked secret and network access are every Role on every profile, and Audit Entries name whoever the holder claims to be. Forged entries cannot be told from real ones. This follows from the design in #92, and may be acceptable once the NetworkPolicy exists, but `networkPolicy.enabled` is `false` by default, so a chart with Replicas should not leave this port open by default (#121). There is also one secret with no overlap, so rotating it means restarting all Replicas together.

### N5. Open redirect after sign-in through a tab in `returnTo`. Medium

`safeReturnTo` refuses `//host` and `/\host`, but `/auth/login?returnTo=/%09/evil.example` signs in and answers `Location: /<TAB>/evil.example`. The WHATWG URL parser, which browsers follow, strips the tab and resolves it to `https://evil.example/` (checked with Node's `URL`, not a browser). `/<TAB>\evil.example` does the same. So a link to the real Volverán, through the real sign-in, ends on an attacker's page: useful for phishing. A newline in `returnTo` answers 500 at the end of a sign-in, with no header injected. Refuse control characters, or better, resolve the value against the app's origin and require the origin to be unchanged.

### N6. Unauthenticated `/auth/login` writes without limit. Medium

Each request adds a sign-in in progress that lasts 10 minutes, with no limit and no rate limit. On PostgreSQL, 2,000 requests in 3.3 s added 2,000 rows. On SQLite they stay in memory: the real image at the chart's defaults (512 MiB, 1 CPU), flooded with 64 connections for 5 minutes, took 103,025 requests with no failure and no restart, using 246 MiB of memory.

So this did **not** take the service down, which is why it is not high. Throughput fell from about 1,000 to about 200 requests a second, on a shared machine; each request sweeps every entry, so the cost is likely CPU that grows with the flood; what that does to other Operators' requests was not measured. The run stopped before the 10-minute expiry, so memory had not reached its plateau. A rate limit at the proxy reduces this; on PostgreSQL the sweep and insert also load the database.

### N7. Lower findings. Low

- Sessions on PostgreSQL store the session id in clear, as the primary key, equal to the id in the cookie. A dump alone does not give a session, because the cookie's signature needs the session secret (tested: 401), but a dump plus that secret does. Hashing the id would remove this. Operator identity and groups are in clear in the same row.
- `/api/profiles` shows broker URLs and the name of the password variable to a signed-in Operator (seen as `admin`; other Roles not compared), and `broker_unreachable` names the management URL. No password appears in any answer tested.
- Groups are fixed at sign-in, so losing a group takes effect only at the next sign-in, up to 12 hours later (documented in `operator.ts`, not tested for the full period). The session idle timeout (#125) shortens this for abandoned sessions only.
- From the note on #127, not retested beyond the counts here: `npm audit` moderates (4 in the root lockfile, 10 in `tools/lint`), the unpinned `# syntax=` line in the `Dockerfile`, `corepack` and `yarn` left in the image, test images pinned by tag. They need fixing or accepting before 1.0.

## Accepted risks

Decided in #92:

- **A Broker Profile without `roles` keeps everyone `admin` (ADR 0007).** Tested: an Operator in no group got 403 on a profile with `roles`, 200 on one without, and could start a Checkout there. The startup warning is logged. Changing this would lock people out on upgrade.
- **The metrics port has no sign-in.** Tested: `/metrics` answers 200 without a session, other paths 404, `POST` 404, no password in the output. It shows operational data such as dead-letter queue depth, and per the metric reference, names of queues in its labels; it holds no Message content. It listens on Volverán's address, on its own port, and is off unless set. With a NetworkPolicy, `networkPolicy.metricsFrom` admits the scraper alone, but the policy is off by default, so close the port if the network is shared.

Proposed, **awaiting a maintainer's decision**:

- Discarded bodies and Audit Entries are not encrypted by Volverán: seen in clear in `audit_message_bodies`. Anyone with read access to the store reads production Messages. #92 seals tokens only; protect the store with its own access control and disk encryption.
- Solo Mode's protection is the loopback address: anyone on the same machine who can reach the port acts as the Operator, with no sign-in.
- Whoever writes the profiles file, or reads the environment, has every credential. Both are trusted.
- No login throttling in Volverán: authentication belongs to the provider. See N6 for what this leaves.

## OWASP ASVS Level 2

Against ASVS 4.0.3, by area. "Tested" means as above. "Suite" means the project's integration suite covers it and it was not repeated. "Read" means only the code was read.

| Area | Status | Notes |
|---|---|---|
| V1 Architecture | Done here | This document |
| V2 Authentication | Delegated, tested | OIDC with PKCE, `state`, `nonce`: wrong `state`, a callback in another browser, and a replayed callback all answer 400. Passwords and MFA belong to the provider. A secret under 32 characters and an http issuer are refused |
| V3 Sessions | Mostly met | New random id at sign-in. Tampered and unsigned cookies 401. `HttpOnly`, `SameSite=Lax`, `Secure` when the redirect URL is https (seen on the login cookie). A copied cookie stops working after sign-out. **No idle timeout** (#125; absence read, not timed). **Sign-out accepts a foreign Origin** (#123) |
| V4 Access control | Met, N4 aside | Suite: `authorization-matrix.test.ts` for every route and Role. Tested: Checkout owner and Role checks through another Replica. #126's guard is low. ADR 0007 accepted |
| V5 Validation and encoding | Partly | Tested: path traversal into static files serves nothing outside the web root. A vhost or queue of `../users` reaches no other management API path. Export's filename is sanitised. Message content comes back as JSON, and is exported as `application/x-ndjson`. Read: no `dangerouslySetInnerHTML`, `innerHTML` or `eval` in `src/web`. Rendering is unproven until #124. **N5** |
| V6 Cryptography | Met for what it does | Read: AES-256-GCM, new IV each time, HKDF-derived key, bound to the row. Tested: tokens and sign-ins unreadable in the database. No key rotation path: a changed key signs people out |
| V7 Errors and logging | **Not met yet** | #125. Audit Entries are the security log, and N4 limits their trust. Tested: wrong broker password and a bad PostgreSQL URL appear in no answer or log |
| V8 Data protection | Partly | Bodies in clear (proposed accepted risk). No `Cache-Control: no-store` on API answers was seen, so #124 may wish to add it |
| V9 Communications | Partly, not tested | TLS ends at the proxy. PostgreSQL TLS has its own settings. The forwarding port is plain HTTP (N3). Not tested here |
| V10 Malicious code | Partly | #127's scans and pinning. N1 |
| V11 Business logic | Suite | Four-eyes Approval, the Delivery Budget and first-wins races have their own tests. Not reviewed further here |
| V12 Files | Met | No uploads. Static files and export as in V5 |
| V13 API | Partly | No CORS. A bodyless POST needs no preflight (#123). Body limit applies, with the wrong status (#125) |
| V14 Configuration | Partly | **Headers** (#124). Non-root, read-only image. N1 |

## What was not done

- No browser: cross-site cookie behaviour, DNS rebinding, tab stripping and rendering of hostile content were each stopped one step short, as stated above.
- No fuzzing, no load test beyond N6, no review of the Helm chart's forwarding set-up, which does not exist yet (#121).
- Not rechecked at later commits. Forwarding covers only the Checkout view and heartbeat so far, and #109, #111 and #114 widen it: review the boundary again before release.
