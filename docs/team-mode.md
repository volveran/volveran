# Setting up Team Mode sign-in

Team Mode (`VOLVERAN_AUTH=oidc`) signs Operators in through any OpenID Connect provider. This page shows what Volverán needs from the provider, then walks through one set-up end to end: Keycloak with JumpCloud as a brokered identity provider. The environment variables are listed in the README under [Team Mode](../README.md#team-mode).

## What Volverán does

- It reads the provider's discovery document (`<issuer>/.well-known/openid-configuration`) at startup and exits with a configuration error if it cannot.
- Sign-in uses the **authorization code flow with PKCE** (`S256`), with `state` and `nonce`. Volverán is a confidential client: it sends its client secret to the token endpoint as `client_secret_post`.
- After sign-in it keeps a server-side session for 12 hours. The browser only holds a random session id in a signed, HTTP-only, `SameSite=Lax` cookie (`Secure` when the redirect URL is `https`). **Sign out** deletes the session in Volverán; it does not sign the person out of the provider.
- The **Operator** is the ID token's `sub`, which Volverán stores as the Operator's identity. It shows the `email` claim, or the `name` claim, or `sub` when neither is present. Ask for the `email` and `profile` scopes (the default) so people see names rather than opaque ids.
- Every `/api/` route answers `401 not_signed_in` without a session; the web app then sends the browser to sign in.
- It reads the Operator's **groups** from the ID token at sign-in (or the userinfo endpoint, when the ID token does not carry them), and gives them a Role on each Broker Profile from the profile's `roles` (see [Roles](#roles) and [The groups claim](#the-groups-claim)).
- Broker access does not change: every Operator acts on a broker with the Broker Profile's shared credentials ([ADR 0004](adr/0004-shared-broker-credentials-first.md)).

## Generic provider set-up

At your provider, create an application (client) with:

| Setting | Value |
|---|---|
| Application type | web application / confidential client (has a client secret) |
| Grant type | authorization code; PKCE allowed (or required) with `S256` |
| Redirect (callback) URL | `https://<volveran-host>/auth/callback`, exactly as the browser reaches Volverán |
| Scopes | `openid email profile` |
| Token endpoint authentication | client secret sent in the request body (`client_secret_post`) |

Then set `VOLVERAN_OIDC_ISSUER` to the provider's issuer (the `issuer` value of its discovery document, without `/.well-known/...`), `VOLVERAN_OIDC_CLIENT_ID` and `VOLVERAN_OIDC_CLIENT_SECRET` to the client's credentials, `VOLVERAN_OIDC_REDIRECT_URL` to the redirect URL above, and `VOLVERAN_SESSION_SECRET` to a random string of at least 32 characters (`openssl rand -hex 32`).

Volverán needs to reach the provider (discovery, token and JWKS endpoints) from where it runs, not only from the Operators' browsers. Behind a reverse proxy, terminate TLS at the proxy and forward to Volverán's port; the redirect URL is the public `https` address.

Issuer examples:

| Provider | Issuer |
|---|---|
| Keycloak | `https://<keycloak-host>/realms/<realm>` |
| Okta | `https://<org>.okta.com` or `https://<org>.okta.com/oauth2/default` |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| JumpCloud (direct) | `https://oauth.id.jumpcloud.com/` |

## Worked example: Keycloak brokering JumpCloud

Here people sign in with their JumpCloud accounts, but Volverán only talks to Keycloak. Keycloak redirects to JumpCloud, receives the person back, and issues its own ID token to Volverán. This keeps Volverán's configuration the same if the company later changes or adds an identity provider. Names below are examples: realm `ops`, Volverán at `https://volveran.example.com`, Keycloak at `https://sso.example.com`.

### 1. JumpCloud: an OIDC application for Keycloak

1. In the JumpCloud Admin Portal, go to **SSO Applications → Add New Application → Custom Application**, and choose **Manage Single Sign-On (SSO) → Configure SSO with OIDC**.
2. Redirect URI: Keycloak's broker endpoint for the identity provider you will create in step 2, `https://sso.example.com/realms/ops/broker/jumpcloud/endpoint`.
3. Client authentication type: **Client Secret Basic**. Login URL: `https://sso.example.com/realms/ops/account`.
4. Under **Attribute Mapping**, include the standard `email` and `profile` scopes.
5. Save, copy the **client ID** and **client secret** shown once, and give the user groups who may use Volverán access to the application.

### 2. Keycloak: JumpCloud as an identity provider

1. In realm `ops`, go to **Identity providers → Add provider → OpenID Connect v1.0**.
2. Alias `jumpcloud` (it is part of the redirect URI above). Discovery endpoint `https://oauth.id.jumpcloud.com/.well-known/openid-configuration`, which fills in the endpoints.
3. Client authentication **Client secret sent as basic auth**, client ID and secret from step 1, client assertion signature algorithm left empty.
4. Under **Advanced**, set scopes to `openid email profile`, turn on **Validate signatures** with **Use JWKS URL**, and turn on **Trust email** if JumpCloud is your source of truth for email addresses.
5. Under **Mappers**, add *Attribute Importer* mappers for `email`, `given_name` → `firstName` and `family_name` → `lastName` if they are not imported already.
6. Optional: to send everyone straight to JumpCloud instead of Keycloak's login page, go to **Authentication → browser flow → Identity Provider Redirector → settings** and set the default identity provider to `jumpcloud`.

### 3. Keycloak: a client for Volverán

1. In realm `ops`, go to **Clients → Create client**: client type **OpenID Connect**, client ID `volveran`.
2. **Capability config**: turn **Client authentication** on (confidential client) and keep only **Standard flow** (the authorization code flow). Under advanced settings, set **Proof Key for Code Exchange Code Challenge Method** to `S256`.
3. **Login settings**: valid redirect URIs `https://volveran.example.com/auth/callback`, web origins `https://volveran.example.com`.
4. Under **Credentials**, keep **Client Id and Secret** and copy the secret.
5. Under **Client scopes**, check that `email` and `profile` are default scopes.

### 4. Volverán

```sh
docker run --rm --read-only -p 8080:8080 \
  -v "$PWD/profiles.yaml:/config/profiles.yaml:ro" \
  -e VOLVERAN_HOST=0.0.0.0 \
  -e VOLVERAN_AUTH=oidc \
  -e VOLVERAN_OIDC_ISSUER=https://sso.example.com/realms/ops \
  -e VOLVERAN_OIDC_CLIENT_ID=volveran \
  -e VOLVERAN_OIDC_CLIENT_SECRET \
  -e VOLVERAN_OIDC_REDIRECT_URL=https://volveran.example.com/auth/callback \
  -e VOLVERAN_SESSION_SECRET \
  -e VOLVERAN_PROD_PASSWORD \
  ghcr.io/volveran/volveran:0.2.0
```

Open `https://volveran.example.com`: the browser goes to Keycloak, then JumpCloud, and back. The top bar shows the signed-in Operator and a **Sign out** button.

The Operator's identity is Keycloak's `sub` for that person (Keycloak's user id, created the first time they sign in through JumpCloud), not JumpCloud's. It stays the same across sign-ins as long as the Keycloak user is kept.

## Roles

Each Broker Profile can give OIDC groups one of three Roles. Each includes the ones before it:

| What the Operator may do on the profile | `viewer` | `operator` | `admin` |
|---|---|---|---|
| See the profile, its vhosts, its queue list and set-up warnings | ✓ | ✓ | ✓ |
| Search and read its Audit Entries (without Discarded bodies) | ✓ | ✓ | ✓ |
| Read Discarded Message bodies in Audit Entries | | ✓ | ✓ |
| Start a Checkout, assign Decisions, Apply | | ✓ | ✓ |
| Restore | | | ✓ |

Write them in the profiles file (or the chart's inline `brokerProfiles.profiles`):

```yaml
profiles:
  - name: prod
    # ...connection settings...
    protected: true
    roles:
      viewer: [support]
      operator: [oncall, sre]
      admin: [platform]
```

- **The groups** come from the claim named by `VOLVERAN_OIDC_GROUPS_CLAIM`; see [The groups claim](#the-groups-claim) below for each provider.
- **The highest role wins.** An Operator in groups mapped to several roles holds the highest of them, so adding someone to a second group never takes access away. No matching group means no role: the profile is left out of their profile list and Audit Entry search, and every route on it answers `403 no_role_on_profile`.
- **Too low a role** answers `403 role_required` with the role needed (`required`) and the one held (`held`). The server checks before it touches the broker, so a modified browser cannot get round it. The web app shows such actions as unavailable, naming the role they need.
- **When changes apply.** Groups are read once, at sign-in, and kept for the session (up to 12 hours). A change at the provider applies at the Operator's next sign-in; a change to `roles` applies when Volverán restarts (which signs everyone out).
- **A profile without `roles`** keeps every signed-in Operator `admin` on it, as before v0.3, and startup logs a warning naming it ([ADR 0007](adr/0007-profiles-without-roles-keep-everyone-admin.md)). Add `roles` to every profile you want restricted.
- **Startup refuses** a `roles` mapping with an unknown role name, an empty group list or a group that is not a string, naming the profile and the key.
- **Solo Mode** ignores `roles` (with one startup log line): its Operator is `admin` everywhere, so the same profiles file works in both modes.
- **The audit trail** records the Operator's role on each new Audit Entry (`role`; entries written before v0.3 have none). `GET /api/session` returns the Operator's `roles` per profile and the `groups` Volverán read, so they can tell whoever manages access which groups they have.
- **No role anywhere.** An Operator who signs in with no role on any Broker Profile sees a page saying so, listing the groups Volverán received (or that it received none), so they can ask for the right access.

### The groups claim

`VOLVERAN_OIDC_GROUPS_CLAIM` (default `groups`; chart value `oidc.groupsClaim`) names the claim holding the Operator's groups:

- **A claim name or a dotted path** into nested claims, such as `realm_access.roles`. A top-level claim whose name itself contains dots (`https://example.com/groups`) is used as is when present. Startup refuses a path with an empty step (`realm_access..roles`).
- **Read from the ID token, else from userinfo.** When the ID token has no claim at that path, Volverán asks the provider's userinfo endpoint (with the access token) and reads the same path there. Providers that keep the ID token small work without extra set-up.
- **A list of strings** is the groups; **a single string** is a group of one. Anything else (a number, an object, a list holding non-strings) counts as **no groups**, and Volverán logs a warning naming the claim, where it was read and its shape. A userinfo request that fails also gives no groups and a warning. Neither ever fails the sign-in: the Operator simply has a role only on profiles without `roles`.
- **To check what arrives**, sign in and open `GET /api/session` (its `groups`), or look at the "no role" page.

Group names in `roles` must match what the provider sends, exactly and case-sensitively.

**Keycloak, with a groups mapper.** In the realm, go to **Clients → volveran → Client scopes → volveran-dedicated → Add mapper → By configuration → Group Membership**. Token claim name `groups`, **Full group path** off (so groups arrive as `support`, not `/support`), **Add to ID token** on, **Add to userinfo** on. Keep the default `VOLVERAN_OIDC_GROUPS_CLAIM=groups`.

**Keycloak, with realm roles.** Without a mapper, Keycloak puts the realm roles in `realm_access.roles`, but by default only in the access token. Go to **Client scopes → roles → Mappers → realm roles** and turn on **Add to ID token** (or **Add to userinfo**), then set `VOLVERAN_OIDC_GROUPS_CLAIM=realm_access.roles`. The list includes Keycloak's own roles (`offline_access`, `uma_authorization`, `default-roles-<realm>`); leave them out of `roles`. In the [worked example](#worked-example-keycloak-brokering-jumpcloud), JumpCloud's groups reach Keycloak only if an identity provider mapper imports them; map them to Keycloak groups or roles there, and use one of the two set-ups above.

**JumpCloud (direct).** In the Volverán application's **SSO** tab, under **Attribute Mapping**, turn on **Include group attribute** and name it, for example `groups` (JumpCloud suggests `memberOf`). Set `VOLVERAN_OIDC_GROUPS_CLAIM` to that name. JumpCloud only sends the user groups that are bound to the application, so bind the groups you map in `roles`.

**Okta.** On the org authorization server (issuer `https://<org>.okta.com`), open the application's **Sign On** tab, edit **OpenID Connect ID Token**, and set **Groups claim type** *Filter*, **Groups claim filter** `groups`, *Matches regex* `.*` (or *Starts with* `volveran-` to send only the relevant groups). On a custom authorization server (`https://<org>.okta.com/oauth2/default`), add the claim under **Security → API → Authorization Servers → Claims** instead: name `groups`, include in **ID Token**, *Always*, value type *Groups*, with the same filter. If the claim is set to appear only on request, it reaches Volverán through userinfo. Okta sends at most 100 groups in a token, so filter rather than send everything. Keep `VOLVERAN_OIDC_GROUPS_CLAIM=groups`.

**Microsoft Entra ID.** In the app registration, go to **Token configuration → Add groups claim**, and pick **Groups assigned to the application** (or *Security groups*), with the ID token type left at **Group ID**. Keep `VOLVERAN_OIDC_GROUPS_CLAIM=groups`. Two things differ from other providers, and Volverán does not work around either:

- **Groups arrive as object ids**, not names: `roles` must list them, for example `admin: ["5f0c3d4e-0000-4c1a-9b9e-2f6b7e1a0c42"]`. Names are only available for groups synchronized from on-premises Active Directory (*sAMAccountName*), or, for cloud groups, with *Groups assigned to the application* and the option to emit their display names. Comment each id in the profiles file with the group's name.
- **Above about 200 groups, the claim is replaced by an overage indicator** (`_claim_names` / `_claim_sources`, pointing at Microsoft Graph). Volverán does not call Graph, and Entra's userinfo does not carry groups, so such an Operator gets no groups. *Groups assigned to the application* avoids this, because only the assigned groups count.

Alternatively, define **app roles** in the app registration, assign groups to them under **Enterprise applications → Users and groups**, and set `VOLVERAN_OIDC_GROUPS_CLAIM=roles`. The `roles` claim carries the app role values (readable names you choose) and has no overage limit.

## Approval

In Team Mode, a Protected Profile adds a second pair of eyes: an Apply with any Decision other than Keep waits for another Operator's Approval before it runs. An Apply where every Decision is Keep needs none, and Restore keeps the typed confirmation only.

1. **The requester** stages Decisions as usual and opens the Apply confirmation, which reads *Request Approval*: they see the summary of Decisions and type the queue name, as for an Apply. The Checkout then waits (`awaiting_approval`): its Decisions cannot change, and *Withdraw request* gives them back. The Checkout's time limit and heartbeat keep running, so the requester keeps the page open while they wait.
2. **An approver** is any other Operator with the role `operator` or `admin` on the profile. The *Approvals* view lists the waiting Applies they may approve, with requester, profile, vhost, queue and the count of each Decision. Opening one shows it read-only: its Decisions, Messages and Message view, as the requester sees them. *Approve* asks for the queue name typed, then runs the Apply on the requester's Checkout, and the requester's page shows the outcome per Message, naming the approver.
3. **Nobody approves their own Apply** (`403 cannot_approve_own_apply`). A `viewer`, and an Operator with no role on the profile, cannot see or open a waiting Checkout, and the owner-only rule of `/api/checkouts/:id` is unchanged: approvers reach a Checkout only under `/api/approvals/`.
4. **The audit trail** records the requester as the Operator of every Audit Entry the approved Apply writes (with the role they held when they asked), and the approver in `approverId` and `approverName`.

A request lives as long as the Checkout: ending it, its time limit, or the requester closing the page (the Checkout ends once the heartbeat window passes) cancels the request, and the Messages go back to the queue.

Approval is on by default for every Protected Profile in Team Mode, and startup logs which profiles require it. To keep typed confirmation only (a team of one, or a profile where that is enough), set `requireApproval: false`:

```yaml
profiles:
  - name: prod
    # ...connection settings...
    protected: true
    requireApproval: false
```

Startup refuses `requireApproval` on a profile that is not protected. Solo Mode ignores it: there is nobody to approve.

## Kubernetes

The [Helm chart](../charts/volveran/README.md) always runs Team Mode, so it takes the settings above as values instead of environment variables: `oidc.issuer`, `oidc.clientId`, `oidc.redirectUrl`, `oidc.scopes` and `oidc.groupsClaim`. The [Kubernetes guide](kubernetes.md) covers the whole install.

**The redirect URL and the route host.** The browser reaches Volverán through the `HTTPRoute` or `Ingress`, so the redirect URL is built on the route's host: with `httpRoute.hostnames: [volveran.example.com]` (or `ingress.hosts`), set `oidc.redirectUrl: https://volveran.example.com/auth/callback` and register exactly that URL with the client. This is the most common sign-in mistake:

- The scheme is `https` even though the pod serves plain HTTP: TLS terminates at the Gateway or ingress controller, and the browser only ever sees the public address. The session cookies are `Secure` because the redirect URL is `https`; there is no proxy setting to add.
- The host is the public route host, not the Service name (`volveran.volveran.svc`) or the pod address.
- Volverán is served at the root of that host. A route under a path prefix (`https://tools.example.com/volveran`) breaks sign-in.

The install notes print the redirect URL to register, and warn when its host is not one of the route hosts. Without a route, `kubectl port-forward service/volveran 8080:8080` and a redirect URL of `http://localhost:8080/auth/callback` work for trying it out.

**Secrets.** The client secret and the session secret come from an existing Secret named in `oidc.existingSecret`, under the keys `client-secret` and `session-secret` (`oidc.clientSecretKey`, `oidc.sessionSecretKey`). The chart never takes them as values, so SOPS, Sealed Secrets or External Secrets can manage the Secret. The pod reads it at startup: restart the Deployment after rotating either one. A new session secret signs everyone out.

**A private CA for the provider.** An internal Keycloak signed by a private CA needs that CA in the pod, or startup fails with *Could not read the OIDC provider's discovery document*. Mount the CA from a ConfigMap or Secret and name it as the OIDC trust bundle:

```yaml
caBundles:
  bundles:
    - name: corporate-ca
      secret: corporate-root-ca      # key ca.crt
  oidcTrust:
    bundle: corporate-ca             # NODE_EXTRA_CA_CERTS=/etc/volveran/ca/corporate-ca/ca.crt
```

Node.js adds it to the public CAs, so public providers keep working. The pod must also reach the provider over the network: with `networkPolicy.egress` rules, include one for the provider, or the pod never becomes ready.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Startup fails: *Could not read the OIDC provider's discovery document* | Wrong `VOLVERAN_OIDC_ISSUER` (compare with the discovery document's `issuer`), or Volverán cannot reach the provider (DNS, proxy, firewall, private CA). |
| The provider shows *invalid redirect_uri* | The client's registered redirect URL differs from `VOLVERAN_OIDC_REDIRECT_URL` (scheme, host, port and path must match exactly). |
| *Sign-in failed: this browser has no sign-in in progress* | Sign-in took more than 10 minutes, the browser blocks cookies, or Volverán was restarted while the person was at the provider. Sign in again. |
| *Sign-in failed: unexpected ID Token "iss"* | The issuer in the token differs from `VOLVERAN_OIDC_ISSUER` (for example a trailing slash, or a different public host name for Keycloak; set Keycloak's hostname). |
| A Broker Profile is missing from the list, or routes answer `403 no_role_on_profile` | None of the Operator's groups is mapped in that profile's `roles`. Check `groups` in `GET /api/session` (or the "no role" page): an empty list means neither the ID token nor userinfo has a usable claim at `VOLVERAN_OIDC_GROUPS_CLAIM`; a warning in Volverán's log names a claim of the wrong shape. Entra ID sends group object ids, not names. Group changes apply at the next sign-in. See [The groups claim](#the-groups-claim). |
| Everyone is signed out after a deploy | Sessions live in the Volverán process; a restart ends them. |
| On Kubernetes, the provider shows *invalid redirect_uri* | `oidc.redirectUrl` is not `https://<route host>/auth/callback` as registered with the client. See [Kubernetes](#kubernetes). |
