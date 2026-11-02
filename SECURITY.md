# Security policy

Volverán handles production Messages and can Discard them, so a vulnerability in it can matter a great deal. Thank you for reporting one privately.

## Reporting a vulnerability

Please do not open a public issue. [Report it privately through GitHub](https://github.com/volveran/volveran/security/advisories/new) (<https://github.com/volveran/volveran/security/advisories/new>). Only the maintainers can read the report.

Say what an attacker can do, the version it affects and how to reproduce it. A guess at the cause is welcome but not needed.

## What happens next

- We answer within 7 days to say whether we have reproduced it, or what else we need.
- We keep you told while we work on a fix, and agree with you when it is published.
- The fix ships in a release, with a GitHub security advisory and a line in the [changelog](CHANGELOG.md). You are credited, unless you prefer not to be.

This is a project maintained without paid support, so these are honest aims rather than a contract.

## Supported versions

| Version | Security fixes |
|---|---|
| The latest minor release | Yes |
| Anything earlier | No: upgrade to the latest minor release |

## Scope

Volverán's own code, its image and its Helm chart. A vulnerability in RabbitMQ, PostgreSQL or your OIDC provider belongs with that project, but tell us if Volverán makes it worse.

## How known vulnerabilities are found

CodeQL, `npm audit` and an image scan run on every pull request and every week, and the image last released is scanned every week ([`security.yml`](.github/workflows/security.yml)). A release does not go out with a high or critical finding known to `npm audit` or to the image scan, whether or not a fix exists, unless it is on the reviewed list in [`.grype.yaml`](.grype.yaml), where each has a stated reason from checking whether Volverán can reach it. That list is empty today.

What this does not promise:

- "Known" means known to these tools on the day they ran. A clean scan is not proof that nothing is vulnerable, and a finding can appear after a release: the weekly scan of the released image looks for those, but a release already published stays as it is until the next one.
- Medium and low findings do not stop a release. They stay visible in the scan's log.
- The image is on Alpine, whose vulnerability data may be thinner than Debian's: a clean result says less about what is unknown to the scanners.
- The scan runs on the amd64 image, built in the release's first job. The arm64 image, and the image pushed by the later job, are built from the same Dockerfile and pins but are not scanned themselves.

Dependabot proposes updates to dependencies, GitHub Actions and the base image, which are pinned by commit and by digest.
