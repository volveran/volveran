# One image, two modes: Solo (no sign-in, loopback only) and Team (OIDC)

The tool started as a localhost-only tool with no login, but it must also run as a shared service with single sign-on (for example JumpCloud, directly or brokered through Keycloak). We ship one image with `auth: none | oidc`. Solo Mode (`none`) refuses to listen on anything but loopback, so the no-sign-in mode can never be exposed by accident; Team Mode (`oidc`) uses generic OIDC (authorization code + PKCE, server-side session) rather than a JumpCloud-specific or SAML integration, so any OIDC provider works and roles come from a configurable groups claim.

## Considered Options

- **Team Mode only**: rejected, running against a dev broker on a laptop should not need an identity provider.
- **SAML**: rejected for now; JumpCloud, Keycloak, Okta and Entra all speak OIDC, and SAML can be added if someone needs it.

## Consequences

- In Docker, Solo Mode runs with `--network host`: the container's loopback is then the machine's loopback. Listening on `0.0.0.0` behind a published port is Team Mode only, because nothing inside the container can check that the port is published on loopback.
