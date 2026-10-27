# Setting up Team Mode sign-in

Team Mode (`VOLVERAN_AUTH=oidc`) signs Operators in through any OpenID Connect provider. This page shows what Volverán needs from the provider, then walks through one set-up end to end: Keycloak with JumpCloud as a brokered identity provider. The environment variables are listed in the README under [Team Mode](../README.md#team-mode).

## What Volverán does

- It reads the provider's discovery document (`<issuer>/.well-known/openid-configuration`) at startup and exits with a configuration error if it cannot.
- Sign-in uses the **authorization code flow with PKCE** (`S256`), with `state` and `nonce`. Volverán is a confidential client: it sends its client secret to the token endpoint as `client_secret_post`.
- After sign-in it keeps a server-side session for 12 hours. The browser only holds a random session id in a signed, HTTP-only, `SameSite=Lax` cookie (`Secure` when the redirect URL is `https`). **Sign out** deletes the session in Volverán; it does not sign the person out of the provider.
- The **Operator** is the ID token's `sub`, which Volverán stores as the Operator's identity. It shows the `email` claim, or the `name` claim, or `sub` when neither is present. Ask for the `email` and `profile` scopes (the default) so people see names rather than opaque ids.
- Every `/api/` route answers `401 not_signed_in` without a session; the web app then sends the browser to sign in.
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

## Kubernetes

The [Helm chart](../charts/volveran/README.md) always runs Team Mode, so it takes the settings above as values instead of environment variables: `oidc.issuer`, `oidc.clientId`, `oidc.redirectUrl` and `oidc.scopes`. The [Kubernetes guide](kubernetes.md) covers the whole install.

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
| Everyone is signed out after a deploy | Sessions live in the Volverán process; a restart ends them. |
| On Kubernetes, the provider shows *invalid redirect_uri* | `oidc.redirectUrl` is not `https://<route host>/auth/callback` as registered with the client. See [Kubernetes](#kubernetes). |
